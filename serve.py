from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser

handler = partial(SimpleHTTPRequestHandler, directory=str(Path(__file__).parent / "dist"))
with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
    webbrowser.open(f"http://127.0.0.1:{server.server_port}/")
    server.serve_forever()
