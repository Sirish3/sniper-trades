"""Run this once to confirm Resend alert delivery is working.

Sends a real test email to ALERT_TO_EMAIL. Usage: python backend/test_email.py
(run from inside backend/, with the venv active and .env filled in).
"""
import sys

from dotenv import load_dotenv

load_dotenv()

from alerts import send_email, validate_email_config  # noqa: E402

if not validate_email_config():
    print("ERROR: Email config invalid. Check .env")
    sys.exit(1)

print("Sending test email...")
ok = send_email(
    "Trading app test alert",
    "Trading app test alert\n"
    "BUY A+: MU $128.50\n"
    "Stop: $121.00 (5.5%)\n"
    "T1: $139.25 | T2: $148.50\n"
    "Shares: 115 | Risk: $1,092\n"
    "If you got this, email alerts are working.",
)
if ok:
    print("SUCCESS — check your inbox")
else:
    print("FAILED — check logs for error")
