#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "cloudflare>=3.0.0",
#     "python-dotenv",
# ]
# ///
"""
Setup Cloudflare Pages project, custom domain, and DNS records.
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
CUSTOM_DOMAIN = "agent.atxconsulting.com"
BASE_DOMAIN = "atxconsulting.com"
SUBDOMAIN = "agent"


def setup_dns(client: cloudflare.Cloudflare, zone_id: str):
    """Configure DNS CNAME record for the custom domain."""
    pages_target = f"{PROJECT_NAME}.pages.dev"
    
    print(f"\nChecking DNS records...")
    records = list(client.dns.records.list(zone_id=zone_id, name=CUSTOM_DOMAIN))
    
    cname_record = None
    for record in records:
        if record.type == "CNAME" and record.name == CUSTOM_DOMAIN:
            cname_record = record
            break
    
    if cname_record:
        if cname_record.content == pages_target:
            print(f"✓ DNS CNAME already correct: {CUSTOM_DOMAIN} → {pages_target}")
        else:
            print(f"  Updating CNAME: {cname_record.content} → {pages_target}")
            client.dns.records.update(
                dns_record_id=cname_record.id,
                zone_id=zone_id,
                name=SUBDOMAIN,
                type="CNAME",
                content=pages_target,
                proxied=True,
            )
            print(f"✓ Updated DNS CNAME: {CUSTOM_DOMAIN} → {pages_target}")
    else:
        print(f"  Creating CNAME: {CUSTOM_DOMAIN} → {pages_target}")
        client.dns.records.create(
            zone_id=zone_id,
            name=SUBDOMAIN,
            type="CNAME",
            content=pages_target,
            proxied=True,
        )
        print(f"✓ Created DNS CNAME: {CUSTOM_DOMAIN} → {pages_target}")


def main():
    client = cloudflare.Cloudflare(
        api_token=os.environ["CLOUDFLARE_API_TOKEN"]
    )

    # Find zone ID for the base domain
    print(f"Looking up zone for '{BASE_DOMAIN}'...")
    zones = list(client.zones.list(name=BASE_DOMAIN))
    if not zones:
        print(f"❌ Zone not found for {BASE_DOMAIN}. Is this domain on Cloudflare?")
        return
    zone_id = zones[0].id
    print(f"✓ Found zone: {zone_id}")

    # Check if project exists
    print(f"\nChecking if project '{PROJECT_NAME}' exists...")
    try:
        project = client.pages.projects.get(
            project_name=PROJECT_NAME,
            account_id=ACCOUNT_ID
        )
        print(f"✓ Project exists: {project.subdomain}")
    except cloudflare.NotFoundError:
        print(f"Creating project '{PROJECT_NAME}'...")
        project = client.pages.projects.create(
            account_id=ACCOUNT_ID,
            name=PROJECT_NAME,
            production_branch="main",
        )
        print(f"✓ Created project: {project.subdomain}")

    # Setup DNS CNAME record
    setup_dns(client, zone_id)

    # List existing Pages domains
    print(f"\nChecking Pages custom domains...")
    domains = client.pages.projects.domains.list(
        project_name=PROJECT_NAME,
        account_id=ACCOUNT_ID
    )
    existing_domains = [d.name for d in domains]
    print(f"  Existing domains: {existing_domains}")

    # Add custom domain if not present
    if CUSTOM_DOMAIN not in existing_domains:
        print(f"Adding custom domain '{CUSTOM_DOMAIN}'...")
        domain = client.pages.projects.domains.create(
            project_name=PROJECT_NAME,
            account_id=ACCOUNT_ID,
            name=CUSTOM_DOMAIN,
        )
        print(f"✓ Added domain: {domain.name} (status: {domain.status})")
    else:
        print(f"✓ Domain '{CUSTOM_DOMAIN}' already configured")

    print(f"\n🎉 Setup complete!")
    print(f"   Project URL: https://{PROJECT_NAME}.pages.dev")
    print(f"   Custom domain: https://{CUSTOM_DOMAIN}")
    print(f"\nNext steps:")
    print(f"  1. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to GitHub secrets")
    print(f"  2. Push to main to trigger deployment")


if __name__ == "__main__":
    main()
