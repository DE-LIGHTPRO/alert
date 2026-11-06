// Proof generation, via zkEmail's SDK loaded from a CDN.
//
// WHY A CDN AND NOT A BUNDLE.
//
// npm on the build machine refuses git-protocol dependencies (`allow-git=none`, an npm 12
// default), and @zk-email/sdk depends on a fork of snarkjs pulled from a GitHub URL. So a
// local install cannot complete without turning that security default off to fetch an
// unaudited fork of the library doing the cryptography. esm.sh serves the package as
// plain ESM, the whole app stays a static file, and nothing gets installed.
//
// WHY IT LOADS LAZILY.
//
// The bundle is several megabytes and carries wasm. Loading it on first paint would make
// the page unusable on exactly the connections this product is for. It loads when a user
// actually asks for a proof, and reports progress while it does, because on a slow link
// this takes long enough that a silent button looks broken.

const SDK_URL = "https://esm.sh/@zk-email/sdk@2.0.11";

/// The compiled blueprint. The version suffix is required by getBlueprint.
export const BLUEPRINT_SLUG = "DE-LIGHTPRO/moniepointdebitalert@v1";

/// Mirrors the SDK's own enum, so a status number is never a bare integer in our code.
export const Status = { None: 0, Draft: 1, InProgress: 2, Done: 3, Failed: 4 };

let sdkPromise = null;

/// Loads the SDK once. Repeated calls share the same download.
export function loadSdk(onProgress = () => {}) {
  if (!sdkPromise) {
    onProgress("Loading the proving library. This is a few megabytes and only happens once.");
    sdkPromise = import(/* @vite-ignore */ SDK_URL)
      .then((mod) => {
        const init = mod.initZkEmailSdk ?? mod.default;
        if (typeof init !== "function") {
          throw new Error("The zkEmail SDK did not export initZkEmailSdk.");
        }
        return init();
      })
      .catch((err) => {
        // Let the next attempt retry rather than caching the failure forever: on a slow
        // link the first load often just runs out of patience.
        sdkPromise = null;
        throw new Error(`Could not load the proving library: ${err.message}`);
      });
  }
  return sdkPromise;
}

/// Is the circuit actually ready to prove against?
///
/// Worth checking before asking a user for their email. A blueprint still compiling will
/// fail somewhere deeper and less legibly.
export async function blueprintStatus(onProgress = () => {}) {
  const sdk = await loadSdk(onProgress);
  const blueprint = await sdk.getBlueprint(BLUEPRINT_SLUG);
  const props = blueprint.props ?? {};
  return {
    blueprint,
    serverStatus: props.serverStatus ?? null,
    clientStatus: props.clientStatus ?? null,
    verifier: props.verifierContract ?? null,
    ready: props.serverStatus === Status.Done,
  };
}

/// Generates a proof from a raw .eml and returns the calldata for AlertEscrow.settle.
///
/// `isLocal: false` proves on zkEmail's server, which means the email leaves the
/// browser. That is acceptable for a demo and not for production, and the UI says so
/// rather than letting a user assume otherwise. Local proving needs the Noir circuit,
/// whose build failed on this blueprint, so it is not an option here yet.
export async function generateProof(emlText, { local = false, onProgress = () => {} } = {}) {
  const sdk = await loadSdk(onProgress);

  onProgress("Fetching the compiled circuit…");
  const blueprint = await sdk.getBlueprint(BLUEPRINT_SLUG);

  const status = blueprint.props?.serverStatus;
  if (status !== Status.Done) {
    const name = Object.keys(Status).find((k) => Status[k] === status) ?? status;
    throw new Error(
      `The circuit is not ready to prove against (status: ${name}). ` +
        `It has to finish compiling on the registry first.`
    );
  }

  onProgress(
    local
      ? "Proving in your browser. Nothing leaves this machine."
      : "Proving on zkEmail's server. Your email is being uploaded to it."
  );

  const prover = blueprint.createProver({ isLocal: local });
  const proof = await prover.generateProof(emlText);

  // Some paths return before the job finishes.
  if (typeof proof.waitForCompletion === "function") {
    onProgress("Waiting for the proof to finish…");
    await proof.waitForCompletion();
  }

  onProgress("Encoding the call…");
  const callData = await proof.createCallData();

  return { proof, callData, publicData: proof.getProofData?.() ?? null };
}

/// The SDK returns Groth16 calldata as a positional array. `settle` wants them named, and
/// getting that mapping wrong produces a proof that verifies against the wrong meaning
/// rather than an error, so it is done in one place with the shape asserted.
export function toSettleArgs(callData) {
  if (!Array.isArray(callData) || callData.length < 4) {
    throw new Error(
      `Unexpected proof calldata shape: expected at least 4 elements, got ${
        Array.isArray(callData) ? callData.length : typeof callData
      }. The circuit's public signal layout may have changed, in which case AlertProofAdapter needs updating too.`
    );
  }
  const [pA, pB, pC, pubSignals] = callData;

  if (!Array.isArray(pA) || pA.length !== 2) throw new Error("pA is not a 2-element array");
  if (!Array.isArray(pB) || pB.length !== 2) throw new Error("pB is not a 2x2 array");
  if (!Array.isArray(pC) || pC.length !== 2) throw new Error("pC is not a 2-element array");
  if (!Array.isArray(pubSignals)) throw new Error("pubSignals is not an array");

  return { pA, pB, pC, pubSignals };
}
