"""Explicit Django CLI for private, inactive account preparation manifests.

Default is a read-only dry run. --apply needs separate target-DB authorization.
No settings module is assumed and no project environment file is read here.
"""
import argparse
import json
import os
from pathlib import Path
import sys

from quality_account_preparation import PreparationBlocked, prepare_accounts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--settings', required=True, help='Explicit reviewed Django settings module')
    parser.add_argument('--reviewed-prior-manifest', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
        prior = (json.loads(args.reviewed_prior_manifest.read_text(encoding='utf-8'))
                 if args.reviewed_prior_manifest else None)
        # Importing the selected settings may load its configured environment;
        # this only happens in an explicitly invoked, reviewed target process.
        os.environ['DJANGO_SETTINGS_MODULE'] = args.settings
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
        import django
        django.setup()
        result = prepare_accounts(manifest, apply=args.apply, reviewed_prior_manifest=prior)
    except PreparationBlocked as error:
        print(json.dumps({'error': str(error), 'changed': False}))
        return 2
    except Exception:
        # Do not print database URLs, settings or arbitrary exception messages.
        # In particular, loss of the COMMIT response is not proof of rollback.
        print(json.dumps({'error': 'preparation_failed', 'outcome': 'unconfirmed',
                          'next_action': 'Read target state before any further apply.'}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result['blocked'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
