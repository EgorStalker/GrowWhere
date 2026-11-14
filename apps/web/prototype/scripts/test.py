"""Run domain, spatial and provider contract tests without network access."""
from pathlib import Path
import sys
import unittest

root=Path(__file__).resolve().parents[4]
suite=unittest.TestSuite()
for directory in [root/'data/pipelines/tests',root/'tests']:
    suite.addTests(unittest.TestLoader().discover(str(directory)))
result=unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
