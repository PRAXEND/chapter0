"""Hold a local OS file lock until the caller closes stdin (including crashes)."""
import os
from pathlib import Path
import sys

target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
with open(target, 'a+b') as handle:
    os.chmod(target, 0o600)
    if os.name == 'nt':
        import msvcrt
        handle.seek(0)
        if not handle.read(1):
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX)
    print('locked', flush=True)
    sys.stdin.buffer.read()
