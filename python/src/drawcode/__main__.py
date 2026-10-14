"""Allow ``python -m drawcode`` to behave like the ``drawcode`` console script."""

import sys

from drawcode.cli import main

if __name__ == "__main__":
    sys.exit(main())
