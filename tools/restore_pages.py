"""Bring a GitHub Pages site back after the repository was made private.

Switching a repository to private *deletes* its GitHub Pages deployment.
Switching it back to public does **not** restore the site - the Pages site
record has to be created again and a deployment triggered.

This script does that, and reports what it finds.

Usage:
    python restore_pages.py [--repo owner/name] [--dry-run]
"""

import argparse
import json
import subprocess
import sys


def run(args, dry_run=False):
    if dry_run:
        print(f"  would run: gh {' '.join(args)}")
        return 0
    print(f"  $ gh {' '.join(args)}")
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode != 0:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    if result.stdout.strip():
        try:
            data = json.loads(result.stdout)
            print(f"    -> {data.get('html_url', data.get('message'))}")
        except json.JSONDecodeError:
            print(f"    -> {result.stdout.strip()}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="wingkinlui/newlabblock",
                        help="the repository, as owner/name")
    parser.add_argument("--dry-run", action="store_true",
                        help="only show what would be done")
    args = parser.parse_args()

    print(f"Checking the Pages site of {args.repo}\n")

    # 1. Is the repository public?  Pages on the free plan needs that.
    print("1. repository visibility")
    code = run(["repo", "view", args.repo, "--json", "visibility"], args.dry_run)
    if code != 0:
        return code

    print("\n2. Pages site")
    code = run(["api", f"repos/{args.repo}/pages"], args.dry_run)
    if code != 0:
        print("   the Pages site does not exist - creating it")
        code = run(
            ["api", f"repos/{args.repo}/pages", "-X", "POST",
             "-f", "build_type=workflow"],
            args.dry_run,
        )
        if code != 0:
            return code

    print("\n3. deployment")
    code = run(["workflow", "run", "pages.yml", "--repo", args.repo], args.dry_run)
    if code != 0:
        return code

    print("\nDone. Watch it with:")
    print(f"  gh run watch --repo {args.repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
