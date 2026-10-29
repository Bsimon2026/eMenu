"""Local stand-in for the two vercel.json rewrites, so the /digimenu/<handle>
routes can be tested before deploying. Run from the project root:

    python serve_with_rewrites.py
"""
import http.server
import os
import re
import socketserver

ROOT = os.getcwd()
PORT = 8898

RE_HANDLE = re.compile(r"^/digimenu/([a-zA-Z0-9][a-zA-Z0-9-]*)/?$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean in ("/digimenu", "/digimenu/"):
            return os.path.join(ROOT, "index.html")
        if RE_HANDLE.match(clean):
            return os.path.join(ROOT, "menu.html")
        return super().translate_path(path)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print("serving with rewrites on", PORT)
        httpd.serve_forever()
