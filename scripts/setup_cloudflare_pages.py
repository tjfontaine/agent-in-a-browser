#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "cloudflare>=3.0.0",
#     "python-dotenv",
# ]
# ///
"""
Setup Cloudflare Worker deployment (optional - wrangler handles most of this).
This script cleans up any old Pages configuration and verifies account access.
Run with: uv run scripts/setup_cloudflare_pages.py
"""

import os
from pathlib import Path
from dotenv import load_dotenv
import cloudflare

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]
PROJECT_NAME = "agent-in-a-browser"
CUSTOM_DOMAIN = "agent.edge-agent.dev"
BASE_DOMAIN = "edge-agent.dev"


def main():
    client = cloudflare.Cloudflare(
        api_token=os.environ["CLOUDFLARE_API_TOKEN"]
    )

    # Verify account access
    print(f"Verifying Cloudflare access...")
    try:
        zones = list(client.zones.list(name=BASE_DOMAIN))
        if zones:
            print(f"✓ Found zone: {zones[0].name} ({zones[0].id})")
        else:
            print(f"❌ Zone not found for {BASE_DOMAIN}")
            return
    except Exception as e:
        print(f"❌ API access failed: {e}")
        return

    # Check for old Pages project and remove if exists
    print(f"\nChecking for old Pages project '{PROJECT_NAME}'...")
    try:
        project = client.pages.projects.get(
            project_name=PROJECT_NAME,
            account_id=ACCOUNT_ID
        )
        print(f"  Found Pages project: {project.subdomain}")
        
        # First delete all custom domains
        domains = list(client.pages.projects.domains.list(
            project_name=PROJECT_NAME,
            account_id=ACCOUNT_ID
        ))
        for domain in domains:
            print(f"  Deleting Pages domain: {domain.name}")
            client.pages.projects.domains.delete(
                domain_name=domain.name,
                project_name=PROJECT_NAME,
                account_id=ACCOUNT_ID
            )
        
        print(f"  Deleting old Pages project (now using Workers)...")
        client.pages.projects.delete(
            project_name=PROJECT_NAME,
            account_id=ACCOUNT_ID
        )
        print(f"✓ Deleted old Pages project")
    except cloudflare.NotFoundError:
        print(f"✓ No Pages project found (good - using Workers instead)")

    # Clean up any manually created CNAME records
    # (wrangler will manage DNS automatically with custom_domain = true)
    zone_id = zones[0].id
    print(f"\nChecking DNS records for {CUSTOM_DOMAIN}...")
    records = list(client.dns.records.list(zone_id=zone_id, name=CUSTOM_DOMAIN))
    
    for record in records:
        if record.type == "CNAME" and "pages.dev" in (record.content or ""):
            print(f"  Deleting old CNAME: {record.content}")
            client.dns.records.delete(dns_record_id=record.id, zone_id=zone_id)
            print(f"✓ Deleted old CNAME (wrangler will create Worker route)")

    print(f"\n🎉 Cleanup complete!")
    print(f"\nWrangler will automatically:")
    print(f"  1. Create the Worker")
    print(f"  2. Set up custom domain: {CUSTOM_DOMAIN}")
    print(f"  3. Manage DNS records and certificates")
    print(f"\nNext: Push to main to trigger deployment via GitHub Actions")


if __name__ == "__main__":
    main()
