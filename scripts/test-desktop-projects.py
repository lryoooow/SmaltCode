"""Compatibility entry point: project grouping is verified with independent local dialogs."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('test-desktop-local-space.py')), run_name='__main__')
