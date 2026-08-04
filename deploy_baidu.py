#!/usr/bin/env python3
# Deploy VPS Resale API to a remote VPS via SSH.
#
# Usage:
#   python3 deploy_baidu.py --host <ip> --user root --pass <password>
#
# Example:
#   python3 deploy_baidu.py --host 120.48.131.216 --user root --pass 'your-password'
#
# Prereqs on the remote host: none (the deploy script installs node/mysql/pm2/nginx).
# Locally: `pip install paramiko` and a built `vps-resale-api.tgz` next to this file.

import paramiko
import os
import time
import argparse
import json

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--user', default='root')
    parser.add_argument('--pass', dest='password')
    args = parser.parse_args()

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        args.host,
        username=args.user,
        password=args.password,
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
        banner_timeout=30
    )
    print('Connected')

    # upload tarball
    sftp = client.open_sftp()
    sftp.put('vps-resale-api.tgz', '/tmp/vps-resale-api.tgz')
    sftp.close()

    # run deploy
    cmd = 'bash /tmp/deploy_vps_resale.sh /tmp/vps-resale-api.tgz'
    stdin, stdout, stderr = client.exec_command(cmd, timeout=600)
    out = stdout.read().decode('utf-8', 'ignore')
    err = stderr.read().decode('utf-8', 'ignore')
    code = stdout.channel.recv_exit_status()

    print('=== OUTPUT ===')
    print(out)
    print('=== STDERR ===')
    print(err)
    print('EXIT', code)

    client.close()

if __name__ == '__main__':
    main()
