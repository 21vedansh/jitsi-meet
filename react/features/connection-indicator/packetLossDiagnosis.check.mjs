/**
 * Checks {@code diagnosePacketLoss} against the timelines for the first version.
 * Run from the repository root:
 *
 * node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     react/features/connection-indicator/packetLossDiagnosis.check.mjs
 */
import assert from 'node:assert/strict';

import {
    createPacketLossDiagnosisState,
    diagnosePacketLoss,
    PACKET_LOSS_DIAGNOSIS_WINDOW_MS,
    trimPacketLossSamples
} from './packetLossDiagnosis.ts';

/**
 * Builds one sample. Omitted directions are N/A.
 *
 * @param {number} timestamp - Sample time, in milliseconds.
 * @param {number|null|undefined} upload - Upload packet loss percent.
 * @param {number|null|undefined} download - Download packet loss percent.
 * @returns {Object} A packet-loss sample.
 */
function sample(timestamp, upload = null, download = null) {
    return {
        download,
        timestamp,
        upload
    };
}

/**
 * Runs one diagnosis and checks the public result.
 *
 * @param {string} name - What this case is proving.
 * @param {Object} options - Samples, time, previous state, and expected result.
 * @returns {Object} The diagnosis result, so a later case can continue from it.
 */
function expectDiagnosis(name, { samples, now, state, diagnosis, direction, activeDirection }) {
    const result = diagnosePacketLoss(samples, now, state);

    assert.equal(result.diagnosis, diagnosis, `${name}: diagnosis`);
    assert.equal(result.direction, direction, `${name}: direction`);
    assert.equal(result.state.activeDirection, activeDirection, `${name}: next state`);
    assert.notEqual(result.state, state, `${name}: state is not reused`);

    return result;
}

const quiet = createPacketLossDiagnosisState();
const tenSeconds = PACKET_LOSS_DIAGNOSIS_WINDOW_MS;

expectDiagnosis('no samples stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: 0,
    samples: [],
    state: quiet
});

expectDiagnosis('one bad sample stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: 0,
    samples: [ sample(0, 50, 0) ],
    state: quiet
});

expectDiagnosis('upload loss under 10 seconds stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: tenSeconds - 1000,
    samples: [ sample(0, 10, 0), sample(tenSeconds - 1000, 10, 0) ],
    state: quiet
});

expectDiagnosis('a dip inside the window stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: tenSeconds,
    samples: [ sample(0, 10, 0), sample(5000, 0, 0), sample(tenSeconds, 10, 0) ],
    state: quiet
});

expectDiagnosis('low loss from the start stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: tenSeconds,
    samples: [ sample(0, 1, 1), sample(tenSeconds, 1, 1) ],
    state: quiet
});

const outgoing = expectDiagnosis('sustained upload loss is outgoing', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds,
    samples: [ sample(0, 10, 0), sample(tenSeconds, 8, 0) ],
    state: quiet
});

expectDiagnosis('upload wins when both directions stay high', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds,
    samples: [ sample(0, 10, 12), sample(tenSeconds, 9, 20) ],
    state: quiet
});

expectDiagnosis('sustained download loss is incoming', {
    activeDirection: 'download',
    diagnosis: 'incoming',
    direction: 'download',
    now: tenSeconds,
    samples: [ sample(0, 0, 10), sample(tenSeconds, 1, 15) ],
    state: quiet
});

expectDiagnosis('N/A samples do not break a high upload run', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds,
    samples: [ sample(0, 10, null), sample(5000, null, null), sample(tenSeconds, 10, null) ],
    state: quiet
});

expectDiagnosis('non-finite values are treated as N/A', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds,
    samples: [ sample(0, 10, Number.NaN), sample(tenSeconds, 10, Number.POSITIVE_INFINITY) ],
    state: quiet
});

expectDiagnosis('samples newer than now are ignored', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: 0,
    samples: [ sample(0, 1, 1), sample(tenSeconds, 40, 40) ],
    state: quiet
});

expectDiagnosis('a high run older than the window stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: (tenSeconds * 2) + 1000,
    samples: [ sample(0, 20, 0), sample(tenSeconds, 20, 0) ],
    state: quiet
});

expectDiagnosis('stale samples do not clear an active problem', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: (tenSeconds * 2) + 1000,
    samples: [ sample(0, 20, 0), sample(tenSeconds, 20, 0) ],
    state: outgoing.state
});

expectDiagnosis('3 percent is not low enough to recover', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds * 3,
    samples: [
        sample(0, 10, 0),
        sample(tenSeconds, 10, 0),
        sample(tenSeconds * 2, 3, 0),
        sample(tenSeconds * 3, 3, 0)
    ],
    state: outgoing.state
});

expectDiagnosis('loss between the two thresholds keeps the outgoing problem', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds * 3,
    samples: [
        sample(0, 10, 0),
        sample(tenSeconds, 10, 0),
        sample(tenSeconds * 2, 5, 0),
        sample(tenSeconds * 3, 3, 0)
    ],
    state: outgoing.state
});

expectDiagnosis('one low sample does not clear the outgoing problem', {
    activeDirection: 'upload',
    diagnosis: 'outgoing',
    direction: 'upload',
    now: tenSeconds + 2000,
    samples: [ sample(0, 10, 0), sample(tenSeconds, 10, 0), sample(tenSeconds + 2000, 1, 0) ],
    state: outgoing.state
});

const recovered = expectDiagnosis('upload staying under 3 percent recovers once', {
    activeDirection: null,
    diagnosis: 'recovered',
    direction: 'upload',
    now: tenSeconds * 3,
    samples: [
        sample(0, 10, 0),
        sample(tenSeconds, 10, 0),
        sample(tenSeconds * 2, 2.9, 0),
        sample(tenSeconds * 3, 0, 0)
    ],
    state: outgoing.state
});

expectDiagnosis('the next healthy update stays quiet', {
    activeDirection: null,
    diagnosis: 'quiet',
    direction: null,
    now: (tenSeconds * 3) + 2000,
    samples: [
        sample(tenSeconds * 2, 2.9, 0),
        sample(tenSeconds * 3, 0, 0),
        sample((tenSeconds * 3) + 2000, 0, 0)
    ],
    state: recovered.state
});

const incoming = expectDiagnosis('download loss becomes the active problem', {
    activeDirection: 'download',
    diagnosis: 'incoming',
    direction: 'download',
    now: tenSeconds,
    samples: [ sample(0, 0, 11), sample(tenSeconds, 0, 11) ],
    state: quiet
});

expectDiagnosis('download staying under 3 percent recovers', {
    activeDirection: null,
    diagnosis: 'recovered',
    direction: 'download',
    now: tenSeconds * 3,
    samples: [
        sample(0, 0, 11),
        sample(tenSeconds, 0, 11),
        sample(tenSeconds * 2, 0, 1),
        sample(tenSeconds * 3, 0, 1)
    ],
    state: incoming.state
});

expectDiagnosis('a recovered upload yields to a new download problem', {
    activeDirection: 'download',
    diagnosis: 'incoming',
    direction: 'download',
    now: tenSeconds * 3,
    samples: [
        sample(0, 12, 0),
        sample(tenSeconds, 12, 12),
        sample(tenSeconds * 2, 1, 12),
        sample(tenSeconds * 3, 1, 12)
    ],
    state: outgoing.state
});

const now = 30000;
const trimmed = trimPacketLossSamples([
    sample(now - (tenSeconds * 3), 10, 10),
    sample(now - (tenSeconds * 2), 10, 10),
    sample(now - tenSeconds, 1, 1)
], now);

assert.deepEqual(
    trimmed.map(item => item.timestamp),
    [ now - (tenSeconds * 2), now - tenSeconds ],
    'trim keeps two windows of samples'
);

console.log('packet loss diagnosis checks passed');
