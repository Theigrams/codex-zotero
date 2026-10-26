"""Optional lossless web transport encoding; never changes the PDF or its pixels."""
import os
import sys
import tempfile
from PIL import Image

source, target = sys.argv[1:]
fd, temporary = tempfile.mkstemp(prefix='.webp-', dir=os.path.dirname(target))
os.close(fd)
try:
    with Image.open(source) as image:
        image.save(temporary, format='WEBP', lossless=True, method=3)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
