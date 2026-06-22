import unittest

from durable_worker import GatherFailed
from durable_worker.workflow import StepFailed


class GatherFailedTest(unittest.TestCase):
    def test_is_a_stepfailed_with_aggregate_error(self):
        errs = [
            {"name": "handle_MEL", "error": {"message": "boom"}},
            {"name": "handle_MVR", "error": {"message": "nope"}},
        ]
        gf = GatherFailed(errs)
        self.assertIsInstance(gf, StepFailed)
        self.assertEqual(gf.errors, errs)
        self.assertEqual(gf.error["errors"], errs)
        self.assertIn("handle_MEL", gf.error["message"])
        self.assertIn("handle_MVR", gf.error["message"])


if __name__ == "__main__":
    unittest.main()
