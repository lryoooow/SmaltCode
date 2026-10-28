"""Publish complete local QA instructions before Electron's polling timer can see them."""
from pathlib import Path
from uuid import uuid4
import time


def publish(path: Path, content: str, encoding: str = 'utf8'):
    ready = path.with_name(path.name + '.' + uuid4().hex + '.ready')
    ready.write_text(content, encoding=encoding)
    for attempt in range(40):
        try:
            ready.replace(path)
            return
        except PermissionError:
            # Windows may briefly hold the old instruction open in the QA reader.
            if attempt == 39:
                raise
            time.sleep(.01)
