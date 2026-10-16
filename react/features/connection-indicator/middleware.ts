import { IStore } from '../app/types';
import { CONFERENCE_JOINED, CONFERENCE_LEFT, CONFERENCE_WILL_LEAVE } from '../base/conference/actionTypes';
import { IJitsiConference } from '../base/conference/reducer';
import { JitsiConnectionQualityEvents } from '../base/lib-jitsi-meet';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import { HIDE_NOTIFICATION } from '../notifications/actionTypes';
import { hideNotification, showSuccessNotification, showWarningNotification } from '../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE } from '../notifications/constants';

import {
    IPacketLossDiagnosisState,
    IPacketLossSample,
    PacketLossDiagnosis,
    createPacketLossDiagnosisState,
    diagnosePacketLoss,
    trimPacketLossSamples
} from './packetLossDiagnosis';
import statsEmitter from './statsEmitter';

/**
 * Identifier for the packet-loss warning and the recovery notice that replaces it.
 */
const PACKET_LOSS_NOTIFICATION_ID = 'PACKET_LOSS_NOTIFICATION_ID';

/**
 * Local connection stats carried by {@code LOCAL_STATS_UPDATED}. Packet loss
 * percents are for the latest stats interval. A missing value is N/A.
 */
interface ILocalConnectionStats {
    packetLoss?: {
        download?: number | null;
        upload?: number | null;
    } | null;
}

/**
 * Samples kept for the current conference.
 */
let samples: IPacketLossSample[] = [];

/**
 * Diagnosis memory passed from one stats update to the next.
 */
let diagnosisState: IPacketLossDiagnosisState = createPacketLossDiagnosisState();

/**
 * Answer currently shown in the notification, so an unchanged answer is not
 * dispatched again.
 */
let shownDiagnosis: PacketLossDiagnosis | null = null;

/**
 * Whether the sticky warning is on screen. Recovery is shown only in that case.
 */
let warningVisible = false;

/**
 * Whether the recovery notice is on screen. Its automatic hide is not a user close.
 */
let recoveryVisible = false;

/**
 * True after the user closes the warning, until that bad stretch ends.
 */
let dismissed = false;

/**
 * True while this middleware is hiding the notification itself.
 */
let hidingOurselves = false;

/**
 * Conference currently being watched, so the listener can be removed on leave.
 */
let listenedConference: IJitsiConference | undefined;

/**
 * Stats listener registered on {@link listenedConference}.
 */
let statsListener: ((stats: ILocalConnectionStats) => void) | undefined;

/**
 * Implements the middleware of the feature connection-indicator.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case CONFERENCE_JOINED: {
        statsEmitter.startListeningForStats(action.conference);
        _startPacketLossWatch(action.conference, store.dispatch);
        break;
    }
    case CONFERENCE_WILL_LEAVE:
    case CONFERENCE_LEFT: {
        _stopPacketLossWatch(store.dispatch);
        break;
    }
    case HIDE_NOTIFICATION: {
        _onPacketLossNotificationHidden(action.uid);
        break;
    }
    }

    return next(action);
});

/**
 * Starts watching local packet loss for one conference.
 *
 * @param {IJitsiConference} conference - The conference that was just joined.
 * @param {Function} dispatch - The Redux dispatch function.
 * @returns {void}
 */
function _startPacketLossWatch(conference: IJitsiConference, dispatch: IStore['dispatch']) {
    _stopPacketLossWatch(dispatch);

    statsListener = (stats: ILocalConnectionStats) => {
        _onLocalStatsUpdated(dispatch, stats);
    };
    listenedConference = conference;
    conference.on(JitsiConnectionQualityEvents.LOCAL_STATS_UPDATED, statsListener);
}

/**
 * Drops the stats listener, the diagnosis memory, and any packet-loss notification.
 *
 * @param {Function} dispatch - The Redux dispatch function.
 * @returns {void}
 */
function _stopPacketLossWatch(dispatch: IStore['dispatch']) {
    if (listenedConference && statsListener) {
        listenedConference.off(JitsiConnectionQualityEvents.LOCAL_STATS_UPDATED, statsListener);
    }

    listenedConference = undefined;
    statsListener = undefined;
    samples = [];
    diagnosisState = createPacketLossDiagnosisState();

    const wasVisible = warningVisible || recoveryVisible;

    warningVisible = false;
    recoveryVisible = false;
    dismissed = false;
    shownDiagnosis = null;

    if (wasVisible) {
        hidingOurselves = true;
        dispatch(hideNotification(PACKET_LOSS_NOTIFICATION_ID));
        hidingOurselves = false;
    }
}

/**
 * Records one local stats update and shows, replaces, or leaves the notification.
 *
 * @param {Function} dispatch - The Redux dispatch function.
 * @param {ILocalConnectionStats} stats - The latest local connection stats.
 * @returns {void}
 */
function _onLocalStatsUpdated(dispatch: IStore['dispatch'], stats: ILocalConnectionStats) {
    const now = Date.now();
    const packetLoss = stats?.packetLoss;

    samples.push({
        download: _toLossPercent(packetLoss?.download),
        timestamp: now,
        upload: _toLossPercent(packetLoss?.upload)
    });
    samples = trimPacketLossSamples(samples, now);

    const result = diagnosePacketLoss(samples, now, diagnosisState);

    diagnosisState = result.state;
    _applyDiagnosis(dispatch, result.diagnosis);
}

/**
 * Turns a stats percent into a sample value. Anything other than a finite
 * number is N/A and is ignored by the diagnosis.
 *
 * @param {number} value - Packet loss percent from the stats update.
 * @returns {number|null} The percent, or null when the direction was not reported.
 */
function _toLossPercent(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    return value;
}

/**
 * Opens or replaces the notification when the diagnosis changes.
 *
 * @param {Function} dispatch - The Redux dispatch function.
 * @param {PacketLossDiagnosis} diagnosis - The latest diagnosis.
 * @returns {void}
 */
function _applyDiagnosis(dispatch: IStore['dispatch'], diagnosis: PacketLossDiagnosis) {
    if (diagnosis === 'outgoing' || diagnosis === 'incoming') {
        if (dismissed || (warningVisible && shownDiagnosis === diagnosis)) {
            return;
        }

        const titleKey = diagnosis === 'outgoing'
            ? 'notify.packetLossOutgoingTitle'
            : 'notify.packetLossIncomingTitle';
        const descriptionKey = diagnosis === 'outgoing'
            ? 'notify.packetLossOutgoingDescription'
            : 'notify.packetLossIncomingDescription';

        dispatch(showWarningNotification({
            descriptionKey,
            titleKey,
            uid: PACKET_LOSS_NOTIFICATION_ID
        }, NOTIFICATION_TIMEOUT_TYPE.STICKY));

        shownDiagnosis = diagnosis;
        warningVisible = true;
        recoveryVisible = false;

        return;
    }

    if (diagnosis === 'recovered') {
        dismissed = false;

        if (warningVisible) {
            dispatch(showSuccessNotification({
                descriptionKey: 'notify.packetLossRecoveredDescription',
                titleKey: 'notify.packetLossRecoveredTitle',
                uid: PACKET_LOSS_NOTIFICATION_ID
            }, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));

            shownDiagnosis = 'recovered';
            warningVisible = false;
            recoveryVisible = true;

            return;
        }

        shownDiagnosis = null;

        return;
    }

    dismissed = false;

    if (!recoveryVisible) {
        shownDiagnosis = null;
    }
}

/**
 * Records a user close of the warning. Hides dispatched by this middleware, and
 * the recovery notice hiding itself, do not count.
 *
 * @param {string} uid - Identifier of the notification that was hidden.
 * @returns {void}
 */
function _onPacketLossNotificationHidden(uid: string) {
    if (uid !== PACKET_LOSS_NOTIFICATION_ID || hidingOurselves) {
        return;
    }

    if (warningVisible) {
        dismissed = true;
        warningVisible = false;
    }

    recoveryVisible = false;
}
