#!/usr/bin/env python3
"""FamilyShield APK build — no Gradle, no network.

Pipeline: aapt2 compile/ link -> javac -> d8 -> zip package -> zipalign -> apksigner.
Outputs build/familyshield-<version>.apk plus a debug-signed keystore on first run.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile

SDK = r"C:\Users\Mohd Arshad Ali\AppData\Local\Tenzy\tools\android-sdk"
BT = os.path.join(SDK, "build-tools", "34.0.0")
PLATFORM = os.path.join(SDK, "platforms", "android-34", "android.jar")
JAVA_HOME = r"C:\Program Files\Java\jdk-25"
JAVAC = os.path.join(JAVA_HOME, "bin", "javac.exe")
KEYTOOL = os.path.join(JAVA_HOME, "bin", "keytool.exe")
AAPT2 = os.path.join(BT, "aapt2.exe")
D8 = os.path.join(BT, "d8.bat")
ZIPALIGN = os.path.join(BT, "zipalign.exe")
APKSIGNER = os.path.join(BT, "apksigner.bat")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
BUILD = os.path.join(ROOT, "build")
KEYSTORE = os.path.join(BUILD, "familyshield.keystore")
KS_PASS = "familyshield"
KS_ALIAS = "familyshield"

STORE_PASS_ARG = ["--ks-pass", "pass:" + KS_PASS]


def run(args, cwd=None, quiet=False):
    printable = " ".join(args) if isinstance(args, list) else str(args)
    if not quiet:
        print(">", printable[:240], flush=True)
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if p.stdout.strip() and (p.returncode != 0 or not quiet):
        print(p.stdout.strip()[:6000], flush=True)
    if p.returncode != 0:
        print(p.stderr.strip()[:6000], flush=True)
        sys.exit("FAILED (%d): %s" % (p.returncode, printable[:200]))
    return p.stdout


def strip_method_parameters(class_dir):
    """Remove the MethodParameters attribute from every class file.

    javac (JDK 25 targeting 8) records synthetic/mandated parameters with an empty name, and
    d8 8.2.2 (build-tools 34.0.0) throws `NullPointerException: Cannot invoke "String.length()"
    because "<parameter1>" is null` while converting that attribute. The attribute is metadata
    only (parameter names for reflection on API 26+), so dropping it is safe and keeps the build
    on the installed SDK.
    """
    dropped = 0

    def skip_cp(buf, pos):
        """Return [(index, kind, utf8_bytes_or_None)] parsed from the constant pool."""
        count = struct.unpack_from(">H", buf, pos)[0]
        pos += 2
        entries = {}
        i = 1
        while i < count:
            tag = buf[pos]
            pos += 1
            if tag == 1:  # Utf8
                ln = struct.unpack_from(">H", buf, pos)[0]
                pos += 2
                entries[i] = bytes(buf[pos:pos + ln]).decode("utf-8", "replace")
                pos += ln
            elif tag in (3, 4):  # Integer, Float
                pos += 4
            elif tag in (5, 6):  # Long, Double (two slots)
                pos += 8
                i += 1
            elif tag in (7, 8, 16, 19, 20):  # Class, String, MethodType, Module, Package
                pos += 2
            elif tag in (9, 10, 11, 12, 17, 18):  # refs, NameAndType, Dynamic, InvokeDynamic
                pos += 4
            elif tag == 15:  # MethodHandle
                pos += 3
            else:
                raise ValueError("unknown constant pool tag %d at %d" % (tag, pos - 1))
            i += 1
        return entries, pos

    def rewrite_attributes(buf, pos, utf8):
        nonlocal dropped
        count = struct.unpack_from(">H", buf, pos)[0]
        pos += 2
        kept = []
        for _ in range(count):
            name_index, length = struct.unpack_from(">HI", buf, pos)
            body_start = pos + 6
            name = utf8.get(name_index, "")
            if name == "MethodParameters":
                dropped += 1
            else:
                kept.append((name_index, bytes(buf[body_start:body_start + length])))
            pos = body_start + length
        return kept, pos

    def emit_attributes(out, attrs):
        out += struct.pack(">H", len(attrs))
        for name_index, body in attrs:
            out += struct.pack(">HI", name_index, len(body)) + body

    for base, _, files in os.walk(class_dir):
        for name in files:
            if not name.endswith(".class"):
                continue
            path = os.path.join(base, name)
            with open(path, "rb") as fh:
                buf = bytearray(fh.read())
            if b"MethodParameters" not in bytes(buf):
                continue
            magic, minor, major, cp_count = struct.unpack_from(">IHHH", buf, 0)
            if magic != 0xCAFEBABE:
                continue
            utf8, pos = skip_cp(buf, 8)
            out = bytearray(buf[:pos])
            access, this, sup, ifaces = struct.unpack_from(">HHHH", buf, pos)
            pos += 8
            out += struct.pack(">HHHH", access, this, sup, ifaces)
            for _ in range(ifaces):
                out += buf[pos:pos + 2]
                pos += 2
            for _section in ("fields", "methods"):
                count = struct.unpack_from(">H", buf, pos)[0]
                out += struct.pack(">H", count)
                pos += 2
                for _ in range(count):
                    head = buf[pos:pos + 6]
                    pos += 6
                    out += head
                    attrs, pos = rewrite_attributes(buf, pos, utf8)
                    emit_attributes(out, attrs)
            attrs, pos = rewrite_attributes(buf, pos, utf8)
            emit_attributes(out, attrs)
            with open(path, "wb") as fh:
                fh.write(out)
    if dropped:
        print("stripped %d MethodParameters attribute(s) for d8 compatibility" % dropped, flush=True)


def main():
    for tool in (AAPT2, JAVAC, D8, ZIPALIGN, APKSIGNER, PLATFORM):
        if not os.path.exists(tool):
            sys.exit("missing tool: " + tool)

    manifest = open(os.path.join(APP, "AndroidManifest.xml"), encoding="utf-8").read()
    version = re.search(r'android:versionName="([^"]+)"', manifest).group(1)
    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    os.makedirs(os.path.join(BUILD, "res"), exist_ok=True)
    os.makedirs(os.path.join(BUILD, "gen"), exist_ok=True)
    os.makedirs(os.path.join(BUILD, "classes"), exist_ok=True)
    os.makedirs(os.path.join(BUILD, "dex"), exist_ok=True)

    # 1. resources
    res_dir = os.path.join(APP, "res")
    compiled = os.path.join(BUILD, "res.zip")
    run([AAPT2, "compile", "--dir", res_dir, "-o", compiled])

    res_apk = os.path.join(BUILD, "res.apk")
    run([
        AAPT2, "link",
        "-o", res_apk,
        "-I", PLATFORM,
        "--manifest", os.path.join(APP, "AndroidManifest.xml"),
        "--java", os.path.join(BUILD, "gen"),
        "--min-sdk-version", "24",
        "--target-sdk-version", "34",
        "--version-code", "1",
        "--version-name", version,
        "-A", os.path.join(APP, "assets"),
        compiled,
    ])

    # 2. java -> class
    sources = []
    for base, _, files in os.walk(os.path.join(APP, "java")):
        sources += [os.path.join(base, f) for f in files if f.endswith(".java")]
    sources += [
        os.path.join(base, f)
        for base, _, files in os.walk(os.path.join(BUILD, "gen"))
        for f in files
        if f.endswith(".java")
    ]
    if not sources:
        sys.exit("no java sources")
    run([JAVAC, "-encoding", "UTF-8", "-source", "8", "-target", "8",
         "-bootclasspath", PLATFORM, "-classpath", PLATFORM,
         "-d", os.path.join(BUILD, "classes"), "-nowarn"] + sources)

    strip_method_parameters(os.path.join(BUILD, "classes"))

    # 3. dex
    classes = []
    for base, _, files in os.walk(os.path.join(BUILD, "classes")):
        classes += [os.path.join(base, f) for f in files if f.endswith(".class")]
    run([D8, "--release", "--min-api", "24", "--lib", PLATFORM,
         "--output", os.path.join(BUILD, "dex")] + classes)

    # 4. package: resources+assets from aapt2, code from d8
    unsigned = os.path.join(BUILD, "familyshield-unsigned.apk")
    with zipfile.ZipFile(res_apk) as src, zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as out:
        for item in src.infolist():
            out.writestr(item, src.read(item.filename))
        dex = os.path.join(BUILD, "dex", "classes.dex")
        out.write(dex, "classes.dex")

    # 5. align + sign
    aligned = os.path.join(BUILD, "familyshield-aligned.apk")
    run([ZIPALIGN, "-p", "-f", "4", unsigned, aligned])

    if not os.path.exists(KEYSTORE):
        print("creating signing key", flush=True)
        run([
            KEYTOOL, "-genkeypair", "-keystore", KEYSTORE, "-alias", KS_ALIAS,
            "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-storepass", KS_PASS, "-keypass", KS_PASS,
            "-dname", "CN=FamilyShield, O=FamilyShield, C=IN",
        ])

    out_apk = os.path.join(BUILD, "familyshield-%s.apk" % version)
    run([
        APKSIGNER, "sign", "--ks", KEYSTORE, "--ks-key-alias", KS_ALIAS,
        "--ks-pass", "pass:" + KS_PASS, "--key-pass", "pass:" + KS_PASS,
        "--min-sdk-version", "24", "--out", out_apk, aligned,
    ])
    run([APKSIGNER, "verify", "--verbose", out_apk])
    size = os.path.getsize(out_apk)
    print("\nBUILD OK  %s  (%.2f MiB)" % (out_apk, size / (1024 * 1024)), flush=True)


if __name__ == "__main__":
    main()
