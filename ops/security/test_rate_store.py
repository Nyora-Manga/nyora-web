import concurrent.futures
import tempfile
import unittest
from pathlib import Path
from rate_store import RateStore, client_key

class RateTests(unittest.TestCase):
    def test_workers_share_atomic_budget_and_window_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'rates.db'
            a, b = RateStore(path), RateStore(path)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda i: (a if i%2 else b).hit('login','same-client',20,300,1000), range(60)))
            self.assertEqual(results.count(0),20)
            self.assertEqual(results.count(300),40)
            self.assertEqual(b.hit('login','same-client',20,300,1300),0)
            self.assertEqual(a.hit('register','same-client',10,3600,1300),0)
            self.assertEqual(a.hit('login','other-client',20,300,1300),0)
            self.assertEqual(RateStore(path).hit('login','same-client',1,300,1301),299)
    def test_ip_canonicalization(self):
        self.assertEqual(client_key('::ffff:192.0.2.1'),'192.0.2.1')
        self.assertEqual(client_key('2001:db8::1'),client_key('2001:db8::2'))
        for bad in ['', 'garbage', '192.0.2.1, 127.0.0.1']:
            with self.assertRaises(ValueError): client_key(bad)

if __name__ == '__main__': unittest.main()
