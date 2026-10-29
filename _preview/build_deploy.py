"""Build the upload package for the Apache host (ogle.live/digimenu).

    python _preview/build_deploy.py

Produces:
    _deploy/digimenu/                 exactly what belongs in public_html/digimenu/
    _deploy/digimenu-upload.zip       the same thing as a zip, with the folder at the root
"""
import os
import shutil
import time
import zipfile

ROOT = os.getcwd()
OUT = os.path.join(ROOT, "_deploy")
SITE = os.path.join(OUT, "digimenu")
ZIP = os.path.join(OUT, "digimenu-upload.zip")
FLAT = os.path.join(OUT, "digimenu-flat.zip")

PAGES = ["index.html", "login.html", "app.html", "menu.html"]


def main():
    if os.path.isdir(OUT):
        # a preview server or the AV scanner can hold a handle for a moment
        for _ in range(4):
            shutil.rmtree(OUT, ignore_errors=True)
            if not os.path.isdir(OUT):
                break
            time.sleep(0.5)
    os.makedirs(SITE, exist_ok=True)

    for page in PAGES:
        shutil.copy2(os.path.join(ROOT, page), os.path.join(SITE, page))

    shutil.copytree(os.path.join(ROOT, "assets"), os.path.join(SITE, "assets"), dirs_exist_ok=True)

    htaccess = os.path.join(ROOT, "_preview", "htaccess.txt")
    shutil.copy2(htaccess, os.path.join(SITE, ".htaccess"))

    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(SITE):
            for f in files:
                full = os.path.join(base, f)
                rel = os.path.relpath(full, SITE)
                z.write(full, os.path.join("digimenu", rel))

    # a second archive with the files at its root, so extracting straight into
    # public_html/digimenu/ cannot produce public_html/digimenu/digimenu/
    with zipfile.ZipFile(FLAT, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(SITE):
            for f in files:
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, SITE))

    count = 0
    for base, _dirs, files in os.walk(SITE):
        count += len(files)
    print("folder :", SITE)
    print("files  :", count)
    print("zip    :", ZIP, round(os.path.getsize(ZIP) / 1024), "KB")
    print("flat   :", FLAT, round(os.path.getsize(FLAT) / 1024), "KB")


if __name__ == "__main__":
    main()
