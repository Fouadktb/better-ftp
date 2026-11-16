"""Authenticated, loopback-only SSH/SFTP fixture with a chrooted file service."""
import asyncio
import os
import sys
from pathlib import Path
import asyncssh

root, host_key, client_public_key = sys.argv[1:4]
port = int(sys.argv[4]) if len(sys.argv) > 4 else 0
authorized = asyncssh.read_public_key(client_public_key)

class Server(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def public_key_auth_supported(self):
        return True

    def validate_password(self, username, password):
        with open(Path(root) / "auth-attempts", "a", encoding="utf-8") as log:
            log.write("password\n")
        return username == "test" and password == "test"

    def validate_public_key(self, username, key):
        with open(Path(root) / "auth-attempts", "a", encoding="utf-8") as log:
            log.write("publickey\n")
        return username == "test" and key.get_fingerprint() == authorized.get_fingerprint()

async def main():
    server = await asyncssh.create_server(
        Server, "127.0.0.1", port,
        server_host_keys=[host_key],
        sftp_factory=lambda channel: asyncssh.SFTPServer(channel, chroot=os.fsencode(root)),
    )
    print(server.get_port(), flush=True)
    await server.wait_closed()

asyncio.run(main())
