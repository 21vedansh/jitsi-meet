/**
 * Decides whether the local participant's packet loss is a sustained problem.
 *
 * Packet loss is the percent of audio and video chunks that never arrive.
 * Upload is the outgoing direction: this participant's microphone and camera.
 * Download is the incoming direction: everyone else's audio and video.
 *
 * The function does not read the network. The caller passes samples and the
 * previous state, then keeps the returned state for the next call.
 */

/**
 * How long packet loss must stay past a threshold before the diagnosis changes.
 * The newest and oldest matching samples must be at least this far apart, so
 * one bad sample cannot open or clear a problem.
 */
export const PACKET_LOSS_DIAGNOSIS_WINDOW_MS = 10000;

/**
 * How long callers should keep samples. Two windows leave the sample that
 * started a run in place after the newest sample moves forward.
 */
export const PACKET_LOSS_SAMPLE_RETENTION_MS = PACKET_LOSS_DIAGNOSIS_WINDOW_MS * 2;

/**
 * Upload or download packet loss, in percent, that counts as a problem when
 * it lasts for {@link PACKET_LOSS_DIAGNOSIS_WINDOW_MS}.
 */
export const PACKET_LOSS_HIGH_PERCENT = 8;

/**
 * Packet loss, in percent, that counts as recovered. Recovery requires every
 * matching sample to stay below this value, so 3% itself is not recovered.
 */
export const PACKET_LOSS_RECOVERED_PERCENT = 3;

/**
 * Upload is outgoing packet loss. Download is incoming packet loss.
 */
export type PacketLossDirection = 'download' | 'upload';

/**
 * Quiet: nothing to say. Outgoing: upload loss is the problem. Incoming:
 * download loss is the problem. Recovered: a problem was showing and that
 * same direction has stayed low. Recovered is reported once, on the
 * transition back to a clear connection.
 */
export type PacketLossDiagnosis = 'incoming' | 'outgoing' | 'quiet' | 'recovered';

/**
 * One packet-loss update. Null means that direction was N/A and is ignored.
 * Values are percents, such as 8 for 8%, not fractions.
 */
export interface IPacketLossSample {

    /**
     * Download packet loss percent, or null when it is N/A.
     */
    download: number | null;

    /**
     * Time of this update, in milliseconds.
     */
    timestamp: number;

    /**
     * Upload packet loss percent, or null when it is N/A.
     */
    upload: number | null;
}

/**
 * Memory carried from one diagnosis call to the next.
 */
export interface IPacketLossDiagnosisState {

    /**
     * Direction currently reported as a problem, or null when none is.
     */
    activeDirection: PacketLossDirection | null;
}

/**
 * The diagnosis for the samples passed to {@link diagnosePacketLoss}.
 */
export interface IPacketLossDiagnosisResult {

    /**
     * What the caller should say about the connection.
     */
    diagnosis: PacketLossDiagnosis;

    /**
     * Direction this diagnosis refers to. Null while the result is quiet.
     */
    direction: PacketLossDirection | null;

    /**
     * State to pass on the next call.
     */
    state: IPacketLossDiagnosisState;
}

/**
 * Initial state, before any problem has been reported.
 *
 * @returns {IPacketLossDiagnosisState} A state with no active problem.
 */
export function createPacketLossDiagnosisState(): IPacketLossDiagnosisState {
    return {
        activeDirection: null
    };
}

/**
 * Drops samples old enough that they can no longer prove a 10 second run.
 *
 * @param {IPacketLossSample[]} samples - Samples collected so far.
 * @param {number} now - Evaluation time, in milliseconds.
 * @returns {IPacketLossSample[]} Samples still inside the retention window.
 */
export function trimPacketLossSamples(
        samples: readonly IPacketLossSample[],
        now: number): IPacketLossSample[] {
    const earliest = now - PACKET_LOSS_SAMPLE_RETENTION_MS;

    return samples.filter(sample => sample.timestamp >= earliest && sample.timestamp <= now);
}

/**
 * Diagnoses sustained packet loss for the local participant.
 *
 * Upload loss wins when both directions stay high, because that is the
 * direction this participant can change. A problem keeps being reported
 * until that same direction stays under {@link PACKET_LOSS_RECOVERED_PERCENT}
 * for the full window. Samples that are N/A, non-finite, or newer than
 * {@code now} are ignored.
 *
 * @param {IPacketLossSample[]} samples - Recent packet-loss updates.
 * @param {number} now - Evaluation time, in milliseconds. Usually the
 * timestamp of the latest sample, or {@code Date.now()} when a sample arrives.
 * @param {IPacketLossDiagnosisState} state - Result state from the previous
 * call. Use {@link createPacketLossDiagnosisState} for the first call.
 * @returns {IPacketLossDiagnosisResult} The diagnosis and the next state.
 */
export function diagnosePacketLoss(
        samples: readonly IPacketLossSample[],
        now: number,
        state: IPacketLossDiagnosisState): IPacketLossDiagnosisResult {
    const uploadHigh = isSustained(samples, now, 'upload', isHighLoss);
    const downloadHigh = isSustained(samples, now, 'download', isHighLoss);

    if (uploadHigh) {
        return toResult('outgoing', 'upload', 'upload');
    }

    if (downloadHigh) {
        return toResult('incoming', 'download', 'download');
    }

    const { activeDirection } = state;

    if (activeDirection) {
        const recovered = isSustained(samples, now, activeDirection, isRecoveredLoss);

        if (recovered) {
            return toResult('recovered', activeDirection, null);
        }

        return toResult(
            activeDirection === 'upload' ? 'outgoing' : 'incoming',
            activeDirection,
            activeDirection);
    }

    return toResult('quiet', null, null);
}

/**
 * True when packet loss is high enough to count toward a problem.
 *
 * @param {number} value - Packet loss percent.
 * @returns {boolean} Whether the value is at or above the high threshold.
 */
function isHighLoss(value: number): boolean {
    return value >= PACKET_LOSS_HIGH_PERCENT;
}

/**
 * True when packet loss is low enough to count toward recovery.
 *
 * @param {number} value - Packet loss percent.
 * @returns {boolean} Whether the value is under the recovery threshold.
 */
function isRecoveredLoss(value: number): boolean {
    return value < PACKET_LOSS_RECOVERED_PERCENT;
}

/**
 * True when the newest uninterrupted run of matching samples covers the window
 * and the newest matching sample is still inside that window.
 *
 * @param {IPacketLossSample[]} samples - Recent packet-loss updates.
 * @param {number} now - Evaluation time, in milliseconds.
 * @param {PacketLossDirection} direction - Upload or download.
 * @param {Function} matches - Test applied to each usable percent.
 * @returns {boolean} Whether the run has lasted long enough.
 */
function isSustained(
        samples: readonly IPacketLossSample[],
        now: number,
        direction: PacketLossDirection,
        matches: (value: number) => boolean): boolean {
    const ordered = samples
        .filter(sample => sample.timestamp <= now)
        .sort((left, right) => left.timestamp - right.timestamp);

    let newest: number | null = null;
    let oldest: number | null = null;

    for (let index = ordered.length - 1; index >= 0; index--) {
        const value = readLoss(ordered[index], direction);

        if (value === null) {
            continue;
        }

        if (!matches(value)) {
            break;
        }

        if (newest === null) {
            newest = ordered[index].timestamp;
        }

        oldest = ordered[index].timestamp;
    }

    if (newest === null || oldest === null) {
        return false;
    }

    if (now - newest > PACKET_LOSS_DIAGNOSIS_WINDOW_MS) {
        return false;
    }

    return newest - oldest >= PACKET_LOSS_DIAGNOSIS_WINDOW_MS;
}

/**
 * Reads one direction from a sample. Null, missing, and non-finite values are
 * N/A and do not count as good or bad.
 *
 * @param {IPacketLossSample} sample - One packet-loss update.
 * @param {PacketLossDirection} direction - Upload or download.
 * @returns {number|null} The percent, or null when the sample is N/A.
 */
function readLoss(sample: IPacketLossSample, direction: PacketLossDirection): number | null {
    const value = sample[direction];

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    return value;
}

/**
 * Builds a result without changing the state object the caller passed in.
 *
 * @param {PacketLossDiagnosis} diagnosis - What the caller should say.
 * @param {PacketLossDirection|null} direction - Direction the diagnosis refers to.
 * @param {PacketLossDirection|null} activeDirection - Direction still in progress.
 * @returns {IPacketLossDiagnosisResult} The diagnosis and the next state.
 */
function toResult(
        diagnosis: PacketLossDiagnosis,
        direction: PacketLossDirection | null,
        activeDirection: PacketLossDirection | null): IPacketLossDiagnosisResult {
    return {
        diagnosis,
        direction,
        state: {
            activeDirection
        }
    };
}
