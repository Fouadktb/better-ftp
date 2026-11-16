"""Loopback-only integration fixture. Install pyftpdlib and pyopenssl in a venv."""
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer

auth = DummyAuthorizer()
auth.add_user("test", "test", sys.argv[1], perm="elradfmwMT")
handler = TLS_FTPHandler if len(sys.argv) > 2 else FTPHandler
handler.authorizer = auth
if len(sys.argv) > 2:
    handler.certfile = sys.argv[2]
    handler.tls_control_required = True
    handler.tls_data_required = True
server = FTPServer(("127.0.0.1", 0), handler)
print(server.socket.getsockname()[1], flush=True)
server.serve_forever()
