#!/usr/bin/env python3
"""Create a consistent, private backup without stopping the console."""
import pathlib,sqlite3,shutil,sys,os
source=pathlib.Path('/var/lib/cohabit-console')
if len(sys.argv)!=2:raise SystemExit('Usage: backup-data.py NEW_BACKUP_DIRECTORY')
destination=pathlib.Path(sys.argv[1])
destination.mkdir(parents=True,exist_ok=False,mode=0o700)
try:
 with sqlite3.connect('file:'+str(source/'console.sqlite')+'?mode=ro',uri=True) as src:
  with sqlite3.connect(destination/'console.sqlite') as dst:src.backup(dst)
 shutil.copyfile(source/'encryption.key',destination/'encryption.key')
 for file in destination.iterdir():os.chmod(file,0o600)
 print('Database and encryption key backed up successfully.')
except Exception:
 print('Backup incomplete; preserve the source data.',file=sys.stderr)
 raise
