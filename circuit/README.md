# Proving a real Moniepoint alert, locally

The zkEmail registry failed to compile this project's blueprint twice: v1 (4 fields,
9 signals) ran 50 minutes and died, v2 (3 fields, 5 signals) ran 17. A smaller circuit
dying sooner is what stopped the size theory and pointed at the service. So the
cryptography is proven here instead, with the registry uninvolved.

    python3 -I circuit/verify-dkim.py fixtures/moniepoint-debit.eml      # plain RSA check
    python3 -I circuit/make-inputs.py fixtures/moniepoint-debit.eml <p=> # Prover.toml
    cd circuit
    nargo execute                                                       # witness
    mkdir -p target/proof target/vk
    bb prove     --scheme ultra_honk -b target/moniepoint_debit_alert.json \
                 -w target/moniepoint_debit_alert.gz -o target/proof
    bb write_vk  --scheme ultra_honk -b target/moniepoint_debit_alert.json -o target/vk
    bb verify    --scheme ultra_honk -k target/vk/vk -p target/proof/proof \
                 -i target/proof/public_inputs

Measured 9 Nov 2026: circuit 133,913 gates, proof 14,080 bytes, generated in 6.9 s,
verifies. Toolchain nargo 1.0.0-beta.5 and bb 0.84.0, which are what zkemail.nr's CI
pins; the 1.0.0 release produces 158 type errors inside the library.

It discriminates, which is the only reason the above means anything:

- the synthetic fixture fails witness generation with "Cannot satisfy constraint"
- so does the real alert with a single bit flipped in the signature
- a single byte flipped in the proof fails verification with "Sumcheck verification failed"

What it proves: Moniepoint's mail provider signed this exact message, and the nullifier
makes it unreplayable. What it does not: the amount or the destination account, which
need the extracting circuit the registry could not build. So this cannot settle an
escrow on its own. It establishes that the cryptography works on a real alert from a
real Nigerian bank, on a laptop, with nobody's permission.
