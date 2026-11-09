"""Prints the third-party notices for a Python environment: Python's own license and the
license and notice files of every installed distribution. Used when building the
fudislte/ai image (services/ai/Dockerfile):

    python scripts/licenses/python_notices.py > THIRD_PARTY_NOTICES.txt
"""

import importlib.metadata as md
import pathlib
import re
import sys
import sysconfig

LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice)", re.I)


def declared_license(meta: md.PackageMetadata) -> str:
    expression = meta.get("License-Expression") or meta.get("License")
    if expression and len(expression) < 200:
        return expression
    classifiers = [c.split(" :: ")[-1] for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    return ", ".join(classifiers) or "license not declared"


def main() -> None:
    print("Third-party software included in the fudislte/ai image\n")
    print("FUDISLTE itself is licensed under the PolyForm Internal Use License 1.0.0 (LICENSE, NOTICE).\n")
    print(f"== Python {sys.version.split()[0]}\n")
    python_license = pathlib.Path(sysconfig.get_paths()["stdlib"]) / "LICENSE.txt"
    print(python_license.read_text() if python_license.exists() else "Python Software Foundation License Version 2")

    missing = []
    for dist in sorted(md.distributions(), key=lambda d: d.metadata["Name"].lower()):
        meta = dist.metadata
        print(f"\n== {meta['Name']} {dist.version} ({declared_license(meta)})")
        files = sorted(
            (f for f in dist.files or [] if ".dist-info" in str(f) and LICENSE_FILE.match(f.name)),
            key=str,
        )
        if not files:
            missing.append(meta["Name"])
            print("The package carries no license file; see its declared license above.")
        for f in files:
            print()
            print(pathlib.Path(f.locate()).read_text(errors="replace").strip())

    if missing:
        print(f"python_notices: without a license file: {', '.join(missing)}", file=sys.stderr)


if __name__ == "__main__":
    main()
