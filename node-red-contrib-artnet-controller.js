const dmxlib = require('dmxnet');
const utils = require('./utils/arc-transition-utils');
const artnetutils = require('./utils/artnet-utils');
const { networkInterfaces } = require('os');

const DEFAULT_MOVING_HEAD_CONFIG = {
    pan_channel: 1,
    tilt_channel: 3,
    pan_angle: 540,
    tilt_angle: 255
};

module.exports = function (RED) {

    /*************************************************
     * Config node for the Art-Net Controller
     */
    function ArtNetController(config) {
        RED.nodes.createNode(this, config);
        this.name     = config.name     || '';
        this.bind     = config.bind     || '0.0.0.0';
        this.port     = config.port     || 6454;
        this.sname    = config.sname    || 'dmxnet';
        this.lname    = config.lname    || 'dmxnet - OpenSource ArtNet Transceiver';
        this.oemcode  = config.oemcode  || '0x2908';
        this.loglevel = config.loglevel || 'warn';

        this.senders = {};

        /**
         * create controller instance
         */
        this.dmxnet = new dmxlib.dmxnet({
            hosts: this.bind === '0.0.0.0' ? undefined : [this.bind],
            oem: this.oemcode,
            sName: this.sname,
            lName: this.lname,
            log: {
                level: this.loglevel
            }
        });

        /**
         * add the sender to local library so that other out nodes can search for existing universes
         * @param {string} sender
         * @param {string} address
         * @param {number} port
         * @param {number} net
         * @param {number} subnet
         * @param {number} universe
         */
        this.registerSender = function(sender, address, port, net, subnet, universe) {
            var uninet = `${net}:${subnet}:${universe}`;
            var adport = `${address}:${port}`;
            if (!this.senders.hasOwnProperty(uninet)) this.senders[uninet] = {};
            this.senders[uninet][adport] = sender;
            this.debug(`Added sender ${sender}: new senders: ${JSON.stringify(this.senders, null, 1)}`);
        };

        /**
         * search for a sender in the local library for existing universes
         * @param {string} address
         * @param {number} port
         * @param {number} net
         * @param {number} subnet
         * @param {number} universe
         * @returns {string} sender
         */
        this.getSender = function(address, port, net, subnet, universe) {
            var uninet = `${net}:${subnet}:${universe}`;
            var adport = `${address}:${port}`;
            if (this.senders.hasOwnProperty(uninet)) {
                // try to find the best address and port combination
                if (this.senders[uninet].hasOwnProperty(adport)) {
                    this.debug(`Found exact match in senders for uninet ${uninet} - ${adport}. Sender: ${this.senders[uninet][adport]}`);
                    return this.senders[uninet][adport];
                }
                // now try to find the next best combination
                for (var key in this.senders[uninet]) {
                    var locAddr = key.split(':')[0];
                    if (locAddr === address) {
                        this.debug(`Found match with same address in senders for uninet ${uninet} - ${key}. Sender: ${this.senders[uninet][key]}`);
                        return this.senders[uninet][key];
                    } 
                }
            }
            return '';
        };

        /**
         * is called whenn node is unloaded
         */
         this.on('close', function() {
            // put this into the dmxnet lib 
            this.dmxnet.listener4.close();
            delete this.dmxnet;
        });
    }
    RED.nodes.registerType("Art-Net Controller", ArtNetController);

    /*************************************************
     * Config node for holding a universe and having the functionality
     * of automatic and timed value transformation
     */
    function ArtNetSender(config) {
        RED.nodes.createNode(this, config);
        this.name             = config.name       || '';
        this.artnetcontroller = config.artnetcontroller;
        this.address          = config.address    || '255.255.255.255';
        this.port             = config.port       || 6454;
        this.net              = config.net        || 0;
        this.subnet           = config.subnet     || 0;
        this.universe         = config.universe   || 0;
        this.maxrate          = config.maxrate    || 10;
        this.refresh          = config.refresh    || 1000;
        this.savevalues       = typeof config.savevalues === 'undefined' ? true : config.savevalues;

        this.controllerObj = RED.nodes.getNode(this.artnetcontroller);

        this.dataDirty = false;             // set to true if dmxData is changed
        this.instSending = false;           // set to true if spontaneous sending is active when maxRate > 0
        this.sendActive = false;            // true while sending of dmxdata has to be delayed

        const self = this;

        // calculate required resolution (intervaltime of main worker, senderClock)
        this.senderClock = 100;             // default 10 per second
        if (this.maxrate == 0) {
            this.senderClock = this.refresh;
            this.instSending = false;
        } else {
            this.senderClock = Math.round((1000 / this.maxrate) < this.refresh ? (1000 / this.maxrate) : this.refresh);
            this.instSending = true;
        }
        /**
         * create sender instance
         */
        this.sender = this.controllerObj.dmxnet.newSender({
            ip: this.address,
            port: this.port,
            net: this.net,
            subnet: this.subnet,
            universe: this.universe,
            base_refresh_interval: this.refresh
        });
        // register this sender in the global library
        this.controllerObj.registerSender(this.id, this.address, this.port, this.net, this.subnet, this.universe);

        this.nodeContext = this.context().global;
        this.contextData = this.nodeContext.get(this.id) || {};

        //this.closeCallbacksMap = {};
        this.transitionsMap = {};

        // get the saved values depending on the switch savevalues
        this.dmxData = this.savevalues ? this.contextData.dmxData || [] : [];
        this.debug(`[ArtNetSender] read dmx-data: (${this.dmxData.length}) -> ${JSON.stringify(this.dmxData)}`);
        if (this.dmxData.length !== 512) {
            this.dmxData = new Array(512).fill(0);
            this.trace('[ArtNetSender] filling, now: ' + this.dmxData.length);
        }
        this.nodeContext.set(this.id, {'dmxData': this.dmxData});

        // transfer the dmx values to the sender instance
        for (var i = 0; i < 512; i++) {
            this.sender.prepChannel(i, this.dmxData[i]);
        }

        // initial transmission
        this.sender.transmit();
        this.log(`[ArtNetSender] initial transmit starting mainWorker with senderClock ${this.senderClock} ms, ${this.instSending ? 'spontaneous sending = on' : 'spontaneous sending = off (send only on refresh)'}`);

        /** ----------------------------------------------
         * functions following
         */

        /**
         * The main system clock timer to handle sending and transitions
         */
        this.mainWorker = setTimeout((function() {
            var currentTime = Date.now();
            // start with transition handling
            for (const currentChannel in this.transitionsMap) {
                var currentTransaction = this.transitionsMap[currentChannel];
                if (currentTransaction.currentStep == 1) currentTransaction.startTime = currentTime;
                if (currentTransaction.currentStep <= currentTransaction.stepsToGo) {       // proceed next step
                    switch (currentTransaction.type) {
                        case 'linear': 
                            this.trace(`[mainWorker] doing step [${currentTransaction.currentStep}] for channel: ${currentChannel}, value: ${currentTransaction.steps[currentTransaction.currentStep].value}`);
                            this.set(currentChannel, currentTransaction.steps[currentTransaction.currentStep].value);
                            this.dataDirty = true;
                            break;

                        case 'arc':
                            break;

                        default:
                            this.warn(`[mainWorker] unknown transition: ${currentTransaction.type}`);
                    }
                    if (currentTransaction.currentStep == currentTransaction.stepsToGo) {
                        // only at the end of the transition
                        this.debug(`[mainWorker] difference between target and actual time : ${currentTime - currentTransaction.startTime - currentTransaction.timeToGo} ms (positive = took too long, negative = to fast)\n (${this.cleanStringify(currentTransaction)})`);
                    }
                    currentTransaction.currentStep++;
                } else {                                                                    // check if transition is to repeat
                    if (currentTransaction.repeat != 0) {
                        if (currentTransaction.currentRepetition != (currentTransaction.repeat - 1)) {
                            // if equal the last repetition has been done, if endless repetions .repeat = -1
                            if (currentTransaction.gapSteps > currentTransaction.currentGapStep) {
                                // care about the break beween repetitions
                                currentTransaction.currentGapStep++;
                            } else {
                                // care about the repetition, return to the start values
                                currentTransaction.currentRepetition++;
                                currentTransaction.currentGapStep = 0;
                                currentTransaction.currentStep = 1;
                                this.set(currentChannel, currentTransaction.startValue);
                                this.dataDirty = true;
                            }
                        } else {
                            // remove the transition
                            this.clearTransition(currentChannel, true);
                        }
                    } else {
                        // remove the transition
                        this.clearTransition(currentChannel, true);
                    }
                }
            }
            // now take care for sending
            if (this.dataDirty) {
                this.dataDirty = false;
                this.sendActive = true;      // for security reasons
                this.sender.transmit();
                this.mainWorker.refresh();
                this.trace(`[mainWorker] Transmitting on isDirty, reset dataDirty flag and retrigger mainWorker`);
            } else {
                // last call of timer. Reset send delay.
                if (this.sendActive) {
                    if (Object.keys(this.transitionsMap).length == 0) {
                        this.trace(`[mainWorker] Called without dirty data. No transition in progress. Reset sendActive`);
                        this.sendActive = false;
                    } else {
                        this.trace(`[mainWorker] Called without dirty data, but with active transition. Keep sendActive and retrigger mainWorker`);
                        this.mainWorker.refresh();
                    }
                } 
            }
            return;
        }.bind(this)), this.senderClock);

        /**
         * Stringify a object without circular references
         * @param {*} object Value to stringify
         * @param {number} space Adds indentation, white space, and line break characters to the return-value JSON text to make it easier to read 
         * @returns {string} Cleanly stringified object
         */
        this.cleanStringify = function (object, space = 0) {
            if (object && typeof object === 'object') {
                object = copyWithoutCircularReferences([object], object);
            }
            return JSON.stringify(object, null, space);
        
            function copyWithoutCircularReferences(references, object) {
                var cleanObject = {};
                Object.keys(object).forEach(function(key) {
                    var value = object[key];
                    if (value && typeof value === 'object') {
                        if (references.indexOf(value) < 0) {
                            references.push(value);
                            cleanObject[key] = copyWithoutCircularReferences(references, value);
                            references.pop();
                        } else {
                            cleanObject[key] = '###_Circular_###';
                        }
                    } else if (typeof value !== 'function') {
                        cleanObject[key] = value;
                    }
                });
                return cleanObject;
            }
        };

        /**
         * save the dmx values to the node context
         */
        this.saveDataToContext = function () {
            this.nodeContext.set(this.id, {'dmxData': this.dmxData});
        };

        /**
         * immediatly send out the dmx buffer or delay sending
         */
        this.sendData = function () {
            if (this.maxrate == 0) return;  // when spontaneous sending is disabled

            if (this.sendActive) {           // only set dirty and no direct transmission
                this.dataDirty = true;
                this.trace(`[sendData] Only setting dataDirty to true`);
            } else {                        // first call with direct transmission
                this.dataDirty = false;
                this.sendActive = true;
                this.sender.transmit();
                this.mainWorker.refresh();
                this.trace(`[sendData] Transmitting spontaneous, set sendActive and retrigger mainWorker`);
            }
        };

        /**
         * set a dmx vlaue and sendout the dmx buffer
         * @param {number} channel dmx channel to set
         * @param {number} value dmx value
         */
        this.setChannelValue = function (channel, value) {
            this.set(channel, value);
            this.sendData();
        };

        /**
         * set the value for a dmx channel in local and senders datastore
         * @param {number} channel dmx channel to set
         * @param {number} value dam value of selected channel
         */
        this.set = function (channel, value) {
            if ((channel >= 1) && (channel <= 512)) {
                if (value < 0) {
                    this.error(`[set] invalid value: ${value}`);
                    return;
                }
                if (value > 255) {
                    this.error(`[set] invalid value: ${value}`);
                    return;
                }
                this.dmxData[channel - 1] = artnetutils.roundChannelValue(value);
                this.sender.prepChannel(channel - 1, artnetutils.roundChannelValue(value));
            } else {
                this.error(`[set] invalid channel: ${channel}`);
            }
        };

        /**
         * get a specific dmx value
         * @param {number} channel dmx channel to obtain
         * @returns {number} dmx value
         */
        this.get = function (channel) {
            return parseInt(this.dmxData[channel - 1] || 0);
        };

        // ##############################################################
        // region transition map logic
        // ##############################################################
        /**
         * clear all active transitions. Is called on close node
         */
        this.clearTransitions = function () {
            for (var channel in this.transitionsMap) {
                if (this.transitionsMap.hasOwnProperty(channel)) {
                    this.clearTransition(channel);
                }
            }
            // reset maps
            this.transitionsMap = {};
//            this.closeCallbacksMap = {};
        };

        /**
         * clear a single transition
         * @param {number} channel dmx base channel of the transition
         * @param {boolean} skipDataSending if true no dmx data will be sent after clerance
         */
        this.clearTransition = function (channel, skipDataSending) {
            var transition = this.transitionsMap[channel];

            if (transition) {
                this.log(`[clearTransition] Clear transition: ${this.cleanStringify(transition)}, skipDataSending: ${skipDataSending}`);
                // set end value immediately
                if (transition.targetValue) {
                    this.set(transition.targetValue);
                }
                // skip data sending if we have start_buckets in payload
                if (!skipDataSending) {
                    this.sendData();
                }
                // remove transition from map
                delete this.transitionsMap[channel];
            }
        };

        /**
         * add a transition to the 
         * @param {number} channel dmx base channel of the transition
         * @param {string} type type of transition to add
         * @param {number} value startvalue of transition
         */
        this.addTransition = function (channel, type, value) {
            this.debug(`[addTransition] Add transition, transition: ${type} channel: ${channel}, value: ${value}`);
            this.clearTransition(channel);
            var transitionItem = {
                'type': type,
                'channel': channel, 
                'steps': [],
                'targetValue' : 0,
                'repeat' : 0,
                'gapSteps' : 0,
                'currentGapStep' : 0,
                'currentRepetition' : 0,
                'currentStep' : 1,
                'startValue' : 0,
                'stepsToGo' : 0,
                'startTime' : 0,
                'timeToGo' : 0
            };
            if (value) {
                transitionItem.value = parseInt(value);
            }
            this.transitionsMap[channel] = transitionItem;
//            this.trace(`[addTransition] Maps after addTransition:\ntransitionsMap: ${this.cleanStringify(this.transitionsMap)}\ncloseCallbacksMap: ${this.cleanStringify(this.closeCallbacksMap)}`);
        };

        // ##############################################################
        // end region transition map logic
        // ##############################################################

        /**
         * the input function. Called by the ArtNet-In node
         * @param {any} msg the message object routed to this node
         */
         this.input = function(msg) { 
            var payload = msg.payload;
            var transition = payload.transition;
            var duration = parseInt(payload.duration || 0);
            var i = 0;

            this.debug(`[input] received input to sender, payload: ${JSON.stringify(payload)} `);

            // processing start_buckets
            if (payload.start_buckets && Array.isArray(payload.start_buckets)) {
                this.debug(`[input] processing start_buckets`);
                for (i = 0; i < payload.start_buckets.length; i++) {
                    this.clearTransition(payload.start_buckets[i].channel, true);
                    // skip data sending to device
                    this.set(payload.start_buckets[i].channel, payload.start_buckets[i].value);
                }
                this.sendData();
            }

            // processing transitions
            if (transition === "arc") {
                try {
                    if (!payload.end || !payload.center) {
                        this.error(`[input] Invalid payload for transition "arc"`);
                    }

                    var arcConfig = payload.arc || DEFAULT_MOVING_HEAD_CONFIG;

                    var cv_phi = payload.start.pan;
                    var cv_theta = payload.start.tilt;

                    var interval = {start: 0, end: 1};
                    if (Array.isArray(payload.interval) && payload.interval.length > 1) {
                        interval.start = payload.interval[0];
                        interval.end = payload.interval[1];
                    }

                    //add transition without target value
                    this.addTransition(arcConfig.tilt_channel, "arc");
                    this.addTransition(arcConfig.pan_channel, "arc");

                    this.moveToPointOnArc(cv_theta, cv_phi,
                        payload.end.tilt, payload.end.pan,
                        payload.center.tilt, payload.center.pan,
                        duration, interval, arcConfig, 
                        payload.repeat, payload.gap);
                } catch (e) {
                    this.error("[input] ERROR " + e.message);
                }
            } else if (transition === "linear") {
                if (payload.channel) {
                    this.debug(`[input] add a transition "linear" for single value`);
                    this.addTransition(payload.channel, "linear");
                    this.fadeToValue(payload.channel, payload.value, duration, payload.repeat);
                } else if (Array.isArray(payload.buckets)) {
                    this.debug(`[input] add transitions "linear" for some buckets`);
                    for (i = 0; i < payload.buckets.length; i++) {
                        this.addTransition(payload.buckets[i].channel, "linear");
                        this.fadeToValue(payload.buckets[i].channel, payload.buckets[i].value, duration, payload.repeat, payload.gap);
                    }
                } else {
                    this.error(`[input] Invalid payload. No channel, no buckets in transition "linear"`);
                }
            } else {    // no transition
                if (payload.channel) {
                    this.debug(`[input] now sending single value`);
                    this.clearTransition(payload.channel, true);
                    this.set(payload.channel, payload.value);
                    this.sendData();
                } else if (Array.isArray(payload.buckets)) {
                    for (i = 0; i < payload.buckets.length; i++) {
                        this.clearTransition(payload.buckets[i].channel, true);
                        this.set(payload.buckets[i].channel, payload.buckets[i].value);
                    }
                    this.debug(`[input] now sending buckets`);
                    this.sendData();
                } else {
                    this.error(`[input] Invalid payload. No channel, no buckets`);
                }
            }
        };
        //});

        /**
         * Add the steps for a linear transition to the transitionsMap and start the transition
         * @param {number} channel Channel on which this trnsition is done
         * @param {number} new_value Value to go to
         * @param {number} transition_time Total time the transition should take
         * @param {number} repeat (optional) Number of repetitions to do
         * @param {number} gap (optional) Value in ms to wait between repetitions 
         */
        this.fadeToValue = function (channel, new_value, transition_time, repeat = 0, gap = 0) {
            var oldValue = this.get(channel);
            var steps = Math.ceil(transition_time / this.senderClock);
            var gapSteps = Math.ceil(gap / this.senderClock);
            var transition = this.transitionsMap[channel];
            if (!transition) {
                this.warn(`[fadeToValue] called with channel: ${channel}. No transition in progress !!`);
                return;    
            }

            this.trace(`[fadeToValue] called with channel: ${channel}, new_value: ${new_value}, transition_time: ${transition_time}, starting from value: ${oldValue}, repeat: ${repeat}, gapSteps`);
            // calculate difference between new and old values
            var diff = Math.abs(oldValue - new_value);
            if (diff / steps <= 1) {
                steps = diff;
            }
            // should we fade up or down?
            var direction = (new_value > oldValue);
            var value_per_step = diff / steps;
            var time_per_step = transition_time / steps;

            // set basic values for this transition
            transition.targetValue = new_value;
            transition.repeat = repeat;
            transition.gapSteps = gapSteps;
            transition.startValue = oldValue;
            transition.timeToGo = time_per_step * steps;

            for (var i = 1; i <= steps; i++) {
                var valueStep = direction === true ? value_per_step : -value_per_step;
                var iterationValue = oldValue + i * valueStep;
                this.trace(`iterationValue: ${iterationValue}`);
                // create step
                transition.steps[i] = {
                    'value' : Math.round(iterationValue),
                    'time' : i * time_per_step,
                    'step' : i
                };
                transition.stepsToGo = i;
            }

            // start transition
            this.sendData();
            this.trace(`[fadeToValue] Maps after fadeToValue: transitionsMap: ${this.cleanStringify(this.transitionsMap, 1)}`);
        };

        /**
         * to be Überarbeited
         */
        this.moveToPointOnArc = function (_cv_theta, _cv_phi, _tilt_nv, _pan_nv, _tilt_center, _pan_center, transition_time, interval, arcConfig, repeat = 0, gap = 0) {
            const self = this;
            try {
            // current value
            var cv_theta = artnetutils.channelValueToRad(_cv_theta, arcConfig.tilt_angle); //tilt
            var cv_phi = artnetutils.channelValueToRad(_cv_phi, arcConfig.pan_angle); // pan

            // target value
            var nv_theta = artnetutils.channelValueToRad(_tilt_nv, arcConfig.tilt_angle);
            var nv_phi = artnetutils.channelValueToRad(_pan_nv, arcConfig.pan_angle);

            // center value
            var tilt_center = artnetutils.channelValueToRad(_tilt_center, arcConfig.tilt_angle); //tilt
            var pan_center = artnetutils.channelValueToRad(_pan_center, arcConfig.pan_angle); // pan

            this.debug(`[moveToPointOnArc] Input points:
                curPoint: ${cv_theta}, ${cv_phi}
                newPoint: ${nv_theta}, ${nv_phi}
                newPoint2: ${utils.radiansToDegrees(nv_theta)}, ${utils.radiansToDegrees(nv_phi)}
                centerPoint: ${tilt_center}, ${pan_center}`);
            // convert points to Cartesian coordinate system
            this.debug("[moveToPointOnArc] *************************************");
            this.debug("[moveToPointOnArc] 1 -> convert  points to cartesian");
            var currentPoint = utils.toCartesian({phi: cv_phi, theta: cv_theta});
            var newPoint = utils.toCartesian({phi: nv_phi, theta: nv_theta});
            var centerPoint = utils.toCartesian({phi: pan_center, theta: tilt_center});
            var vn = centerPoint;
            vn = utils.normalizeVector(vn);
            centerPoint = utils.calcCenterPoint(centerPoint, currentPoint);

            this.tracePoint("currentPoint ", currentPoint);
            this.tracePoint("newPoint     ", newPoint);
            this.tracePoint("centerPoint  ", centerPoint);
            this.debug("[moveToPointOnArc] *************************************");
            var movement_point = centerPoint;

            // move center of circle to center of coordinates
            this.debug("[moveToPointOnArc] 2 -> move to O(0,0,0)");
            currentPoint = utils.movePointInCartesian(currentPoint, centerPoint, -1);
            newPoint = utils.movePointInCartesian(newPoint, centerPoint, -1);
            centerPoint = utils.movePointInCartesian(centerPoint, centerPoint, -1);
            this.tracePoint("currentPoint ", currentPoint);
            this.tracePoint("newPoint     ", newPoint);
            this.tracePoint("centerPoint  ", centerPoint);
            this.debug("[moveToPointOnArc] *************************************");

            // calculate normal vector (i,j,k) for circle plane (three points)
            this.debug("[moveToPointOnArc] 3 -> normal vector calculation");
            //var vn = getNormalVector(centerPoint,currentPoint,newPoint);
            //vn = normalizeVector(vn);
            this.tracePoint("normalVector ", vn);
            var backVector = utils.rotatePoint_xy_quarterion(utils.OZ, vn);
            this.tracePoint("BackVector", backVector);
            this.debug("[moveToPointOnArc] *************************************");

            this.debug("[moveToPointOnArc] 4 -> rotate coordinate system");
            currentPoint = utils.rotatePoint_xy_quarterion(currentPoint, vn);
            newPoint = utils.rotatePoint_xy_quarterion(newPoint, vn);
            centerPoint = utils.rotatePoint_xy_quarterion(centerPoint, vn);

            this.tracePoint("currentPoint ", currentPoint);
            this.tracePoint("newPoint     ", newPoint);
            this.tracePoint("centerPoint  ", centerPoint);
            this.debug("[moveToPointOnArc] *************************************");


            this.debug("[moveToPointOnArc] 4.1 -> rotate coordinate system back for check");
            var currentPoint1 = utils.rotatePoint_xy_quarterion(currentPoint, backVector);
            var newPoint1 = utils.rotatePoint_xy_quarterion(newPoint, backVector);
            var centerPoint1 = utils.rotatePoint_xy_quarterion(centerPoint, backVector);

            this.tracePoint("currentPoint1 ", currentPoint1);
            this.tracePoint("newPoint1     ", newPoint1);
            this.tracePoint("centerPoint1  ", centerPoint1);
            this.debug("[moveToPointOnArc] *************************************");

            var radius = utils.getDistanceBetweenPointsInCartesian(currentPoint, centerPoint);
            var radius2 = utils.getDistanceBetweenPointsInCartesian(newPoint, centerPoint);
            if (Math.abs(radius2 - radius) > utils.EPSILON) {
                this.error("[moveToPointOnArc] Invalid center point");
                return;
            }
            this.debug("[moveToPointOnArc] 5 -> parametric equation startT and endT calculation");
            //find t parameter for start and end point
            var currentT = (Math.acos(currentPoint.x / radius) + 2 * Math.PI) % (2 * Math.PI);
            var newT = (Math.acos(newPoint.x / radius) + 2 * Math.PI) % (2 * Math.PI);
            this.debug(`[moveToPointOnArc] T parameters rad: ${radius}, ${currentT}, ${newT}`);
            this.debug("[moveToPointOnArc] T parameters degree", utils.radiansToDegrees(currentT), utils.radiansToDegrees(newT));
            this.debug("[moveToPointOnArc] *************************************");

            var actualAngle = newT - currentT;
            var angleDelta = Math.abs(actualAngle) <= Math.PI ? actualAngle : -(actualAngle - Math.PI);

            var steps = transition_time / this.senderClock;
            var time_per_step = this.senderClock;
            var angleStep = angleDelta / steps;
            // limit steps for interval
            var startStep = parseInt(steps * interval.start);
            var endStep = parseInt(steps * interval.end);
            this.debug(`[moveToPointOnArc] angleStep: ${angleDelta}, ${angleStep}, ${utils.radiansToDegrees(angleDelta)}`);
            this.debug(`[moveToPointOnArc] angleStep: ${steps}, ${startStep}, ${endStep}`);

            var timeoutID;
            var counter = 0;

            for (var i = startStep; i <= endStep; i++) {
                var t = currentT + i * angleStep;
                timeoutID = setTimeout(function (t) {
                    self.log(`im timer t: ${self.cleanStringify(t)}`);
                    // get point in spherical coordinates
                    var iterationPoint = utils.getIterationPoint(t, radius, backVector, movement_point);
                    var tilt = artnetutils.validateChannelValue(artnetutils.radToChannelValue(iterationPoint.theta, arcConfig.tilt_angle));
                    var pan = artnetutils.validateChannelValue(artnetutils.radToChannelValue(iterationPoint.phi, arcConfig.pan_angle));

                    self.debug("[moveToPointOnArc] sphericalP     ", "r: ", parseFloat(iterationPoint.r).toFixed(4), "theta:", parseFloat(iterationPoint.theta).toFixed(4), "phi:", parseFloat(iterationPoint.phi).toFixed(4), "\n",
                        "T:             ", parseFloat(t).toFixed(4), "\n",
                        "TILT: ", tilt, "pan: ", pan);
                    self.debug("[moveToPointOnArc] **********************");

                    self.set(arcConfig.tilt_channel, tilt);
                    self.set(arcConfig.pan_channel, pan);
                    self.sendData();
                }, counter * time_per_step, t);
                counter++;
                //this.addTransitionTimeout(arcConfig.pan_channel, timeoutID);
                //this.addTransitionTimeout(arcConfig.tilt_channel, timeoutID);
            }

            if (endStep == 1) {
                var tilt = artnetutils.validateChannelValue(artnetutils.radToChannelValue(nv_theta, arcConfig.tilt_angle));
                var pan = artnetutils.validateChannelValue(artnetutils.radToChannelValue(nv_phi, arcConfig.pan_angle));

                timeoutID = setTimeout(function () {
                    self.set(arcConfig.tilt_channel, tilt);
                    self.set(arcConfig.pan_channel, pan);
                    self.sendData();
                    //delete self.closeCallbacksMap[arcConfig.tilt_channel];
                    //delete self.closeCallbacksMap[arcConfig.pan_channel];
                }, transition_time);

                //this.addTransitionTimeout(arcConfig.pan_channel, timeoutID);
                //this.addTransitionTimeout(arcConfig.tilt_channel, timeoutID);

                // add close callback to set channels to new_value in case redeploy and all timeouts stopping
                /*
                this.closeCallbacksMap[arcConfig.pan_channel] = this.closeCallbacksMap[arcConfig.tilt_channel] = (function () {
                    this.set(arcConfig.tilt_channel, tilt);
                    this.set(arcConfig.pan_channel, pan);
                });*/
            }
            } catch(err) {
                this.error(err);
            }
        };

        /**
         * Trace and log a point to the console
         * @param {*} tag 
         * @param {*} point 
         */
        this.tracePoint = function (tag,point){
            this.trace(tag + " : " + parseFloat(point.x).toFixed(4) + " : " + parseFloat(point.y).toFixed(4) + " : " + parseFloat(point.z).toFixed(4));
        };

        /**
         * called when node is destroyed
         */
         this.on('close', function() {
            clearTimeout(this.mainWorker);
            this.clearTransitions();
            this.saveDataToContext();
            this.sender.stop();
            delete this.sender;
        });
    }
    RED.nodes.registerType("Art-Net Sender", ArtNetSender);

    /*************************************************
     * The out node for sending data from a flow
     */
    function ArtNetOutNode(config) {
        RED.nodes.createNode(this, config);
        this.name             = config.name       || '';
        this.artnetsender     = config.artnetsender;
        this.ignoreaddress    = typeof config.ignoreaddress === 'undefined' ? false : config.ignoreaddress;

        this.senderObject =  RED.nodes.getNode(this.artnetsender);
        this.controllerObj = RED.nodes.getNode(this.senderObject.artnetcontroller);

        this.log(`[ArtNetOutNode] senderObject: ${this.senderObject.type}:${this.senderObject.id}, controllerObj: ${this.controllerObj.type}:${this.controllerObj.id}`);

        this.on('input', function (msg) {
            this.trace(`get payload: ${JSON.stringify(msg.payload)}`);
            var payload = msg.payload;
            var locNet, locSubnet, locUniverse;
            // check if ignore address is set
            if (this.ignoreaddress) {
                this.debug(`[input] ignore address is set, routing to default sender`);
                this.senderObject.input(msg);
                return;
            }
            // check if address information in payload
            if ((payload.net === undefined) && (payload.subnet === undefined) && (payload.universe === undefined)) {
                this.debug(`[input] no address information found, routing to default sender`);
                this.senderObject.input(msg);
                return;
            }
            // ok there if address information, now check each value
            if (payload.net !== undefined) {
                if ((parseInt(payload.net) < 0) || (parseInt(payload.net) > 15)) {
                    this.warn(`[input] invalid net in payload: ${payload.net}`);
                    locNet = this.senderObject.net;
                } else {
                    locNet = parseInt(payload.net);
                }
            } else {
                locNet = this.senderObject.net;
            }
            if (payload.subnet !== undefined) {
                if ((parseInt(payload.subnet) < 0) || (parseInt(payload.subnet) > 15)) {
                    this.warn(`[input] invalid net in payload: ${payload.subnet}`);
                    locSubnet = this.senderObject.subnet;
                } else {
                    locSubnet = parseInt(payload.subnet);
                }
            } else {
                locSubnet = this.senderObject.net;
            }
            if (payload.universe !== undefined) {
                if ((parseInt(payload.universe) < 0) || (parseInt(payload.universe) > 15)) {
                    this.warn(`[input] invalid universe in payload: ${payload.universe}`);
                    locUniverse = this.senderObject.universe;
                } else {
                    locUniverse = parseInt(payload.universe);
                }
            } else {
                locUniverse = this.senderObject.net;
            }
            // now look for a matching sender
            var locSender = this.controllerObj.getSender(this.senderObject.address, this.senderObject.port, locNet, locSubnet, locUniverse);
            if (locSender) {
                this.debug(`[input] ${locNet}:${locSubnet}:${locUniverse}, routing to sender: ${locSender}`);
                RED.nodes.getNode(locSender).input(msg);
            } else {
                this.warn(`[input] no sender found for specified address information: ${locNet}:${locSubnet}:${locUniverse}, routing to default sender`);
                this.senderObject.input(msg);
            }
        });

    }
    RED.nodes.registerType("Art-Net Out", ArtNetOutNode);

    /*************************************************
     * ArtNetInNode is like ArtNetReceiver (in dmxnet speech)
     */
    function ArtNetInNode(config) {
        RED.nodes.createNode(this, config);
    }
    RED.nodes.registerType("Art-Net In", ArtNetInNode);

    /*************************************************
     * Get IP information and pass it to the configuration dialog
     */
     RED.httpAdmin.get("/ips", RED.auth.needsPermission('artnet.read'), function(req,res) {
        try {
            const nets = networkInterfaces();
            var IPs4 = [{name: '[IPv4] 0.0.0.0 - ' + RED._("artnet.names.allips"), address: '0.0.0.0', family: 'ipv4'}];
            // IPv6 not implemented yet
            //var IPs6 = [{name: '[IPv6] ::',      address: '::',      family: 'ipv6'}];
            for (const name of Object.keys(nets)) {     // Lookup all interfaces
                for (const net of nets[name]) {
                    // Skip over non-IPv4
                    if (net.family === 'IPv4') {        // First IPv4 address
                        IPs4.push({name: '[IPv4] ' + net.address + ' - ' + name, address: net.address, family: 'ipv4'});
                    }
                }
            }
            res.json(IPs4);
        } catch(err) {
            res.json([RED._("artnet.errors.list")]);
        }
    });
};