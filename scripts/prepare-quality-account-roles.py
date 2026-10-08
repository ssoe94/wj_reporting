"""Review inactive quality-role preparation; no activation or runtime settings."""
import argparse
import json
import os
from pathlib import Path
import sys

from quality_account_preparation import PreparationBlocked
from quality_account_role_preparation import prepare_quality_roles


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-receipt', type=Path, required=True)
    parser.add_argument('--role-review-reference', required=True)
    parser.add_argument('--reviewed-role-receipt', type=Path)
    parser.add_argument('--settings', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        source = json.loads(args.source_receipt.read_text(encoding='utf-8'))
        prior = (json.loads(args.reviewed_role_receipt.read_text(encoding='utf-8'))
                 if args.reviewed_role_receipt else None)
        os.environ['DJANGO_SETTINGS_MODULE'] = args.settings
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
        import django
        django.setup()
        result = prepare_quality_roles(source, args.role_review_reference, apply=args.apply,
                                       reviewed_role_receipt=prior)
    except PreparationBlocked as error:
        print(json.dumps({'error': str(error), 'changed': False}))
        return 2
    except Exception:
        print(json.dumps({'error': 'role_preparation_failed', 'outcome': 'unconfirmed',
                          'next_action': 'Read target state before another apply.'}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
