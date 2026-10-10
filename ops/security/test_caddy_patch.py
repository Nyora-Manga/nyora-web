import unittest
from harden_caddy import patch
class CaddyTests(unittest.TestCase):
    def test_targets_both_layouts_without_changing_csp(self):
        for api in ['api.nyora.xyz','(nyora_api_handlers)']:
            original=api+' {\n handle {\n reverse_proxy localhost:8788\n }\n}\nweb.nyora.xyz {\n header Content-Security-Policy "unchanged"\n try_files {path} /index.html\n file_server\n}\n'
            stage=patch(original);enforced=patch(stage,True);twice=patch(enforced,True)
            self.assertEqual(twice.count('# Nyora catalogue access BEGIN'),1)
            self.assertEqual(twice.count('# Nyora trusted edge identity'),1)
            self.assertIn('path /app/session /sources/catalog',enforced)
            self.assertIn('Content-Security-Policy "unchanged"',enforced)
            self.assertNotIn('try_files',enforced)
