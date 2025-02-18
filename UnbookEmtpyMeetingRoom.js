/**
 * Topic: Releasing the room when no one is attending
 * Author: fyodormartens@gmail.com (Modified to fix stack overflow and newline errors)
 * Version: 1.0
 */

import xapi from 'xapi';

// Configuration constants
const USE_SOUND = false;
const SOUND_LEVEL = 50;
const USE_ACTIVE_CALLS = true;
const USE_PRESENTATION_MODE = true;
const USE_PEOPLE_COUNT_ONLY = false;
const USE_PRESENCE_AND_COUNT = true;
const USE_GUI_INTERACTION = true;
const MIN_BEFORE_BOOK = 5; // in minutes
const MIN_BEFORE_RELEASE = 5; // in minutes

const USE_ULTRASOUND = !USE_PEOPLE_COUNT_ONLY;
let alertDuration;
let refreshInterval;
let delete_timeout;
let forcedUpdate;
let bookingIsActive = false;
let listenerShouldCheck = true;
let bookingId;
let meetingId;

class PresenceDetector {
    constructor() {
        this._data = {
            peopleCount: 0,
            peoplePresence: false,
            inCall: false,
            presenceSound: false,
            sharing: false,
        };
        this._lastFullTimer = 0;
        this._lastEmptyTimer = 0;
        this._roomIsFull = false;
        this._roomIsEmpty = false;
    }

    async enableDetector() {
        console.log("Enabling presence detection...");
        await xapi.config.set('HttpClient Mode', 'On');
        await xapi.config.set('RoomAnalytics PeopleCountOutOfCall', 'On');
        await xapi.config.set('RoomAnalytics PeoplePresenceDetector', 'On');
        console.log("Success, presence detection enabled");
    }

    async _getData(command) {
        try {
            return await xapi.status.get(command);
        } catch (error) {
            console.error("Couldn't run the command:", command, " Error: ", error);
            return -1;
        }
    }

    _isRoomOccupied() {
        if (!USE_PRESENCE_AND_COUNT) {
            return this._data.peopleCount > 0 || 
                   (USE_ULTRASOUND && this._data.peoplePresence) || 
                   (USE_ACTIVE_CALLS && this._data.inCall) || 
                   (USE_SOUND && this._data.presenceSound) || 
                   (USE_PRESENTATION_MODE && this._data.sharing);
        }
        return (this._data.peopleCount > 0 && this._data.peoplePresence) || 
               (USE_ACTIVE_CALLS && this._data.inCall) || 
               (USE_SOUND && this._data.presenceSound) || 
               (USE_PRESENTATION_MODE && this._data.sharing);
    }

    _processPresence() {
        const now = Date.now();
        if (this._isRoomOccupied()) {
            if (this._lastFullTimer === 0) {
                console.log("Room occupancy detected - starting timer...");
                this._lastFullTimer = now;
                this._lastEmptyTimer = 0;
            } else if (now > (this._lastFullTimer + MIN_BEFORE_BOOK * 60000)) {
                this._roomIsFull = true;
                this._roomIsEmpty = false;
                this._lastFullTimer = now;
            }
        } else {
            if (this._lastEmptyTimer === 0) {
                console.log("Room empty detected - starting timer...");
                this._lastEmptyTimer = now;
                this._lastFullTimer = 0;
            } else if (now > (this._lastEmptyTimer + MIN_BEFORE_RELEASE * 60000) && !this._roomIsEmpty) {
                this._roomIsFull = false;
                this._roomIsEmpty = true;
                if (listenerShouldCheck) {
                    listenerShouldCheck = false;
                    this._startCountdown();
                }
            }
        }
    }

    _startCountdown() {
        console.log("No presence Detected");
        this._showPrompt();
        alertDuration = 60;
        refreshInterval = setInterval(updateEverySecond, 1000);
        delete_timeout = setTimeout(this._handleTimeout.bind(this), 60000);
    }

    async _showPrompt() {
        try {
            await xapi.command("UserInterface Message Prompt Display", {
                Text: "This room seems unused. It will be self-released.<br>Press check-in if you have booked this room",
                FeedbackId: 'alert_response',
                'Option.1': 'CHECK IN',
            });
        } catch (error) {
            console.error("Error showing prompt:", error);
        }
    }

    async _handleTimeout() {
        try {
            await xapi.Command.UserInterface.Message.Prompt.Clear({ FeedbackId: "alert_response" });
            await xapi.Command.UserInterface.Message.TextLine.Clear({});
            clearInterval(forcedUpdate);

            if (bookingId) {
                const book = await xapi.Command.Bookings.Get({ Id: bookingId });
                await xapi.Command.Bookings.Respond({
                    Type: "Decline",
                    MeetingId: book.Booking.MeetingId
                });
            }

            this._resetState();
        } catch (error) {
            console.error("Error handling timeout:", error);
        }
    }

    _resetState() {
        bookingId = null;
        bookingIsActive = false;
        this._lastFullTimer = 0;
        this._lastEmptyTimer = 0;
        this._roomIsFull = false;
        this._roomIsEmpty = false;
    }

    async updatePresence() {
        try {
            const [calls, presence, peopleCount, sound, presentation] = await Promise.all([
                this._getData('SystemUnit State NumberOfActiveCalls'),
                this._getData('RoomAnalytics PeoplePresence'),
                this._getData('RoomAnalytics PeopleCount Current'),
                this._getData('RoomAnalytics Sound Level A'),
                this._getData('Conference Presentation Mode')
            ]);

            this._updateDataFromSensors(calls, presence, peopleCount, sound, presentation);
            this._processPresence();
        } catch (error) {
            console.error("Error updating presence:", error);
        }
    }

    _updateDataFromSensors(calls, presence, peopleCount, sound, presentation) {
        this._data.sharing = USE_PRESENTATION_MODE && presentation !== 'Off';
        this._data.peopleCount = parseInt(peopleCount) === -1 ? 0 : parseInt(peopleCount);
        this._data.peoplePresence = presence === 'Yes';
        
        if (!USE_ULTRASOUND) {
            this._data.peoplePresence = this._data.peopleCount > 0;
        }
        
        this._data.inCall = USE_ACTIVE_CALLS && parseInt(calls) > 0;
        this._data.presenceSound = USE_SOUND && parseInt(sound) > SOUND_LEVEL;
    }
}

function updateEverySecond() {
    alertDuration--;
    if (alertDuration <= 0) {
        clearInterval(refreshInterval);
        xapi.Command.UserInterface.Message.TextLine.Clear({});
    } else {
        xapi.command('UserInterface Message TextLine Display', {
            text: 'This room seems unused. It will be released in ' + alertDuration + ' seconds.<br>Use the check-in button on the touch panel if you have booked this room.',
            duration: 0
        });

        if (alertDuration % 3 === 0) {
            xapi.command("UserInterface Message Prompt Display", {
                Text: "This room seems unused. It will be self-released.<br>Press check-in if you have booked this room",
                FeedbackId: 'alert_response',
                'Option.1': 'CHECK IN',
            }).catch(console.error);
        }
    }
}

async function setupEventListeners(presence) {
    // Booking start event
    xapi.Event.Bookings.Start.on(async (booking_info) => {
        try {
            console.log("Booking " + booking_info.Id + " detected");
            const availability = await xapi.Status.Bookings.Availability.Status.get();
            
            if (availability === 'BookedUntil') {
                bookingId = booking_info.Id;
                const booking = await xapi.Command.Bookings.Get({ Id: booking_info.Id });
                meetingId = booking.Booking.MeetingId;
                bookingIsActive = true;
                listenerShouldCheck = true;
                
                await presence.updatePresence();
                setupForcedUpdate(presence);
            }
        } catch (error) {
            console.error("Error in booking start handler:", error);
        }
    });

    // Booking end event
    xapi.Event.Bookings.End.on(async (booking_info) => {
        try {
            await xapi.Command.UserInterface.Message.Prompt.Clear({ FeedbackId: "alert_response" });
            await xapi.Command.UserInterface.Message.TextLine.Clear({});
            clearInterval(forcedUpdate);
            clearTimeout(delete_timeout);
            bookingIsActive = false;
            listenerShouldCheck = false;
            bookingId = null;
            meetingId = null;
            presence._lastFullTimer = 0;
            presence._lastEmptyTimer = 0;
            presence._roomIsFull = false;
            presence._roomIsEmpty = false;
            console.log("Booking " + booking_info.Id + " ended Stop Checking");
        } catch (error) {
            console.error("Error in booking end handler:", error);
        }
    });

    // Set up other event listeners
    setupSensorEventListeners(presence);
    setupUIEventListeners(presence);
}

function setupSensorEventListeners(presence) {
    xapi.Status.SystemUnit.State.NumberOfActiveCalls.on((calls) => {
        if (bookingIsActive) {
            presence._data.inCall = USE_ACTIVE_CALLS && parseInt(calls) > 0;
            if (listenerShouldCheck) presence._processPresence();
        }
    });

    xapi.Status.RoomAnalytics.PeoplePresence.on((value) => {
        if (bookingIsActive) {
            presence._data.peoplePresence = value === 'Yes';
            if (presence._data.peoplePresence) {
                handlePresenceDetected(presence);
            }
            if (listenerShouldCheck) presence._processPresence();
        }
    });

    xapi.Status.RoomAnalytics.PeopleCount.Current.on((count) => {
        if (bookingIsActive) {
            const peopleCount = parseInt(count) === -1 ? 0 : parseInt(count);
            presence._data.peopleCount = peopleCount;
            
            if (!USE_ULTRASOUND) {
                presence._data.peoplePresence = peopleCount > 0;
            }
            
            if (peopleCount > 0) {
                handlePresenceDetected(presence);
            }
            
            if (listenerShouldCheck) presence._processPresence();
        }
    });

    xapi.Status.RoomAnalytics.Sound.Level.A.on((level) => {
        if (bookingIsActive) {
            presence._data.presenceSound = USE_SOUND && parseInt(level) > SOUND_LEVEL;
            if (listenerShouldCheck) presence._processPresence();
        }
    });

    xapi.Status.Conference.Presentation.Mode.on((mode) => {
        if (bookingIsActive) {
            presence._data.sharing = USE_PRESENTATION_MODE && mode !== 'Off';
            if (listenerShouldCheck) presence._processPresence();
        }
    });
}

function setupUIEventListeners(presence) {
    xapi.Event.UserInterface.Extensions.on(() => {
        if (bookingIsActive && USE_GUI_INTERACTION) {
            handleUserInteraction(presence);
        }
    });

    xapi.event.on('UserInterface Message Prompt Response', (event) => {
        if (event.FeedbackId === 'alert_response' && event.OptionId === '1') {
            handleCheckIn(presence);
        }
    });
}

function setupForcedUpdate(presence) {
    forcedUpdate = setInterval(() => {
        if (listenerShouldCheck) {
            presence._processPresence();
        }
    }, (MIN_BEFORE_BOOK * 60000) + 1000);
}

function handlePresenceDetected(presence) {
    xapi.Command.UserInterface.Message.Prompt.Clear({ FeedbackId: "alert_response" });
    xapi.Command.UserInterface.Message.TextLine.Clear({});
    clearTimeout(delete_timeout);
    clearInterval(refreshInterval);
    presence._roomIsFull = true;
    presence._roomIsEmpty = false;
    listenerShouldCheck = true;
}

function handleUserInteraction(presence) {
    clearTimeout(delete_timeout);
    clearInterval(refreshInterval);
    xapi.Command.UserInterface.Message.Prompt.Clear({ FeedbackId: "alert_response" });
    xapi.Command.UserInterface.Message.TextLine.Clear({});
    
    presence._roomIsFull = true;
    presence._roomIsEmpty = false;
    presence._lastFullTimer = Date.now();
    presence._lastEmptyTimer = 0;
    listenerShouldCheck = true;
}

function handleCheckIn(presence) {
    clearTimeout(delete_timeout);
    clearInterval(refreshInterval);
    xapi.Command.UserInterface.Message.TextLine.Clear({});
    
    listenerShouldCheck = true;
    presence._data.peoplePresence = true;
    presence._roomIsEmpty = false;
    presence._roomIsFull = true;
}

async function beginDetection() {
    const presence = new PresenceDetector();
    await presence.enableDetector();
    await setupEventListeners(presence);
}

// Start the detection process
beginDetection().catch(console.error);
