
import base64

from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

BASE_DIR = Path(__file__).resolve().parent
PRIVATE_KEY_FILE = BASE_DIR / "vapid_private.pem"

if PRIVATE_KEY_FILE.exists():
    print("Private key already exists.")
    print("Do not generate another key unless you intend to reset subscriptions.")
    raise SystemExit(1)

private_key = ec.generate_private_key(
    ec.SECP256R1()
)

private_pem = private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.TraditionalOpenSSL,
    encryption_algorithm=serialization.NoEncryption()
)

# Create the private key file.
with open(PRIVATE_KEY_FILE, "xb") as file:
    file.write(private_pem)

# Generate the matching public key.
public_key = private_key.public_key()

public_bytes = public_key.public_bytes(
    encoding=serialization.Encoding.X962,
    format=serialization.PublicFormat.UncompressedPoint
)

public_key_base64 = base64.urlsafe_b64encode(
    public_bytes
).rstrip(b"=").decode("ascii")

print("\nVAPID KEYS GENERATED SUCCESSFULLY!\n")
print("Private key saved to: vapid_private.pem")
print("\nVAPID PUBLIC KEY:")
print(public_key_base64)
