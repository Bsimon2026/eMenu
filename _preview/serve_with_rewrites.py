"""Local stand-in for both deployment shapes, so routes can be tested before
anything is uploaded.

    python _preview/serve_with_rewrites.py [root] [port]

Emulates:
  * Apache subfolder hosting (public_html/digimenu/) - real files win, and
    /digimenu/<handle> falls back to that folder's menu.html (.htaccess rule)
  * Vercel root hosting - /digimenu -> index.html, /digimenu/<handle> -> menu.html,
    /digimenu/assets/* -> /assets/*
"""
import http.server
import os
import re
import socketserver
import sys

RE_HANDLE = re.compile(r"^/digimenu/([a-zA-Z0-9][a-zA-Z0-9-]*)/?$")
RE_ASSETS = re.compile(r"^/digimenu/(assets/.*)$")


class Handler(http.server.SimpleHTTPRequestHandler):
    root = os.getcwd()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=Handler.root, **kw)

    def _file(self, rel):
        path = os.path.join(Handler.root, rel.lstrip("/"))
        return path if os.path.isfile(path) else None

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]

        real = self._file(clean)
        if real:
            return real

        if RE_HANDLE.match(clean):
            for cand in ("/digimenu/menu.html", "/menu.html"):
                got = self._file(cand)
                if got:
                    return got

        if clean in ("/digimenu", "/digimenu/"):
            for cand in ("/digimenu/index.html", "/index.html"):
                got = self._file(cand)
                if got:
                    return got

        m = RE_ASSETS.match(clean)
        if m:
            got = self._file("/" + m.group(1))
            if got:
                return got

        return super().translate_path(path)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    Handler.root = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8898
    with socketserver.TCPServer(("", port), Handler) as httpd:
        print("serving", Handler.root, "on", port)
        httpd.serve_forever()
