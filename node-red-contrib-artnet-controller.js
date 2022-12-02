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
        this.resolution       = config.resolution || 100;
        this.savevalues       = typeof config.savevalues === 'undefined' ? true : config.savevalues;

        this.controllerObj = RED.nodes.getNode(this.artnetcontroller);
        this.dataDirty = false;             // set to true if dmxData is changed
        this.sendDelay = false;             // true while sending of dmxdata has to be delayed

        var self = this;

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

        // get the saved values depending on the switch savevalues
        this.dmxData = this.savevalues ? this.contextData.dmxData || [] : [];
        this.debug(`read dmx-data: (${this.dmxData.length}) -> ${JSON.stringify(this.dmxData)}`);
        if (this.dmxData.length !== 512) {
            this.dmxData = new Array(512).fill(0);
            this.trace('filling, now: ' + this.dmxData.length);
        }
        this.nodeContext.set(this.id, {'dmxData': this.dmxData});

        // transfer the dmx values to the sender instance
        for (var i = 0; i < 512; i++) {
            this.sender.prepChannel(i, this.dmxData[i]);
        }
        // initial transmission
        this.sender.transmit();
        this.log(`[ArtNetSender] initial transmit starting sendTimer`);
        /**
         * create sendTimer
         */
        this.sendTimer = setTimeout((function() {
            if (self.dataDirty) {
                self.dataDirty = false;
                self.sendDelay = true;      // for security reasons
                self.sender.transmit();
                self.sendTimer.refresh();
                self.trace(`[sendTimer] Transmitting on isDirty, reset dataDirty flag and restart timer`);
            } else {
                // last call of timer. Reset send delay.
                if (self.sendDelay) {
                    self.trace(`[sendTimer] Called without dirty data. Reset sendDelay and don't restart timer`);
                } else {
                    self.trace(`[sendTimer] Called without dirty data and without sendDelay. Perhaps first call`);
                }
                self.sendDelay = false;
            }
            return;
        }), (1000/this.maxrate));

        this.closeCallbacksMap = {};
        this.transitionsMap = {};

        /** ----------------------------------------------
         * functions following
         */
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
            if (this.sendDelay) {       // only set dirty and no direct transmission
                this.dataDirty = true;
                this.trace(`[sendData] Only setting dataDirty to true`);
            } else {                    // first call with direct transmission
                this.dataDirty = false;
                this.sendDelay = true;
                this.sender.transmit();
                this.sendTimer.refresh();
                this.trace(`[sendData] Transmitting spontaneous, start timer, set sendDelay`);
            }
        };

        /**
         * set a dmx vlaue and sendout the dmx buffer
         * @param {number} channel dmx channel
         * @param {number} value dmx value
         */
        this.setChannelValue = function (channel, value) {
            this.set(channel, value);
            this.sendData();
        };

        /**
         * set the timeout for a corresponding transition
         * @param {number} channel dmx base channel of the transition
         * @param {any} timeoutId id of previously created timeout
         */
         this.set = function (address, value, transition, transition_time) {
            if (address > 0) {
                if (transition) {
                    this.addTransition(address, transition, value); //TODO move to input
                    this.fadeToValue(address, parseInt(value), transition_time);
                } else {
                    this.dmxData[address - 1] = artnetutils.roundChannelValue(value);
                    this.sender.prepChannel(address - 1, artnetutils.roundChannelValue(value));
                }
            }
        };

        /**
         * get a specific dmx value
         * @param {number} address dmx channel to obtain
         * @returns {number} dmx value
         */
         this.get = function (address) {
            return parseInt(this.dmxData[address - 1] || 0);
        };

        // ##############################################################
        // region transition map logic
        // ##############################################################
        /**
         * is called on close node
         */
        this.clearTransitions = function () {
            for (var channel in this.transitionsMap) {
                if (this.transitionsMap.hasOwnProperty(channel)) {
                    this.clearTransition(channel);
                }
            }
            // reset maps
            this.transitionsMap = {};
            this.closeCallbacksMap = {};
        };
        /**
         * clear a single transition
         * @param {number} channel dmx base channel of the transition
         * @param {boolean} skipDataSending if true no dmx data will be sent after clerance
         */
        this.clearTransition = function (channel, skipDataSending) {
            var transition = this.transitionsMap[channel];
            //var oldChannelValue = this.get(channel);
            // cancel all timeouts
            if (transition && transition.timeouts) {
                for (var i = 0; i < transition.timeouts.length; i++) {
                    clearTimeout(transition.timeouts[i]);
                }
                transition.timeouts.length = 0;
            }
            // finish transition immediately
            if (this.closeCallbacksMap.hasOwnProperty(channel)) {
                this.closeCallbacksMap[channel]();
                // skip data sending if we have start_buckets in payload
                if (!skipDataSending) {
                    this.sendData();
                }
                delete this.closeCallbacksMap[channel];
            }
            // remove transition from map
            delete this.transitionsMap[channel];
        };
        /**
         * add a transition to the 
         * @param {number} channel dmx base channel of the transition
         * @param {string} transition type of transition to add
         * @param {number} value startvalue of transition
         */
        this.addTransition = function (channel, transition, value) {
            this.debug(`[addTransition] Add transition, channel: ${channel}, value: ${value}`);
            this.clearTransition(channel);
            var transitionItem = {"transition": transition, "timeouts": []};
            if (value) {
                transitionItem.value = parseInt(value);
            }
            this.transitionsMap[channel] = transitionItem;
        };
        /**
         * set the timeout for a corresponding transition
         * @param {number} channel dmx base channel of the transition
         * @param {any} timeoutId id of previously created timeout
         */
        this.addTransitionTimeout = function (channel, timeoutId) {
            var transition = this.transitionsMap[channel];
            if (transition) {
                transition.timeouts.push(timeoutId);
            }
        };
        // ##############################################################
        // end region transition map logic
        // ##############################################################

        /**
         * set the timeout for a corresponding transition
         * @param {number} channel dmx base channel of the transition
         * @param {any} timeoutId id of previously created timeout
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
                        duration, interval, arcConfig);
                } catch (e) {
                    this.error("[input] ERROR " + e.message);
                }
            } else if (transition === "linear") {
            } else {
                // no transition
                if (payload.channel) {
                    this.debug(`[input] now sending single value`);
                    this.set(payload.channel, payload.value);
                    this.sendData();
                } else if (Array.isArray(payload.buckets)) {
                    for (i = 0; i < payload.buckets.length; i++) {
                        this.clearTransition(payload.buckets[i].channel, true);
                        this.set(payload.buckets[i].channel, payload.buckets[i].value, transition, duration);
                    }
                    if (!transition) {
                        this.debug(`[input] now sending data without a transition`);
                        this.sendData();
                    }
                } else {
                    this.error(`[input] Invalid payload buckets`);
                }
            }
        };
        //});

        this.fadeToValue = function (channel, new_value, transition_time, resolution) {
            const self = this;
            var oldValue = this.get(channel);
            var steps = transition_time / this.resolution;

            // calculate difference between new and old values
            var diff = Math.abs(oldValue - new_value);
            if (diff / steps <= 1) {
                steps = diff;
            }
            // should we fade up or down?
            var direction = (new_value > oldValue);

            var value_per_step = diff / steps;
            var time_per_step = transition_time / steps;

            var timeoutID;
            for (var i = 1; i < steps; i++) {
                var valueStep = direction === true ? value_per_step : -value_per_step;
                var iterationValue = oldValue + i * valueStep;
                // create time outs for each step
                timeoutID = setTimeout(function (val) {
                    self.setChannelValue(this.channel, Math.round(val));
                }.bind(self), i * time_per_step, iterationValue);
                this.addTransitionTimeout(channel, timeoutID);
            }

            // add close callback to set channels to new_value in case redeploy and all timeouts stopping
            this.closeCallbacksMap[channel] = (function () {
                self.set(channel, new_value);
            });

            timeoutID = setTimeout(function () {
                self.setChannelValue(channel, new_value);
                // clear channel transition on last iteration
                self.clearTransition(channel);
            }, transition_time);
            this.addTransitionTimeout(channel, timeoutID);
        };

        this.moveToPointOnArc = function (_cv_theta, _cv_phi, _tilt_nv, _pan_nv, _tilt_center, _pan_center, transition_time, interval, arcConfig) {
            const self = this;
            // current value
            var cv_theta = artnetutils.channelValueToRad(_cv_theta, arcConfig.tilt_angle); //tilt
            var cv_phi = artnetutils.channelValueToRad(_cv_phi, arcConfig.pan_angle); // pan

            // target value
            var nv_theta = artnetutils.channelValueToRad(_tilt_nv, arcConfig.tilt_angle);
            var nv_phi = artnetutils.channelValueToRad(_pan_nv, arcConfig.pan_angle);

            // center value
            var tilt_center = artnetutils.channelValueToRad(_tilt_center, arcConfig.tilt_angle); //tilt
            var pan_center = artnetutils.channelValueToRad(_pan_center, arcConfig.pan_angle); // pan

            this.debug("[moveToPointOnArc] Input points ", "\n curPoint:", cv_theta, cv_phi, "\n " +
                "newPoint: ", nv_theta, nv_phi, "\n" +
                "newPoint2: ", utils.radiansToDegrees(nv_theta), utils.radiansToDegrees(nv_phi), "\n" +
                "centerPoint: ", tilt_center, pan_center);
            // convert points to Cartesian coordinate system
            this.debug("[moveToPointOnArc] *************************************");
            this.debug("[moveToPointOnArc] 1 -> convert  points to cartesian");
            var currentPoint = utils.toCartesian({phi: cv_phi, theta: cv_theta});
            var newPoint = utils.toCartesian({phi: nv_phi, theta: nv_theta});
            var centerPoint = utils.toCartesian({phi: pan_center, theta: tilt_center});
            var vn = centerPoint;
            vn = utils.normalizeVector(vn);
            centerPoint = utils.calcCenterPoint(centerPoint, currentPoint);

            artnetutils.tracePoint("currentPoint ", currentPoint);
            artnetutils.tracePoint("newPoint     ", newPoint);
            artnetutils.tracePoint("centerPoint  ", centerPoint);
            this.debug("[moveToPointOnArc] *************************************");
            var movement_point = centerPoint;

            // move center of circle to center of coordinates
            this.debug("[moveToPointOnArc] 2 -> move to O(0,0,0) \n");
            currentPoint = utils.movePointInCartesian(currentPoint, centerPoint, -1);
            newPoint = utils.movePointInCartesian(newPoint, centerPoint, -1);
            centerPoint = utils.movePointInCartesian(centerPoint, centerPoint, -1);
            artnetutils.tracePoint("currentPoint ", currentPoint);
            artnetutils.tracePoint("newPoint     ", newPoint);
            artnetutils.tracePoint("centerPoint  ", centerPoint);
            this.debug("[moveToPointOnArc] *************************************");

            // calculate normal vector (i,j,k) for circle plane (three points)
            this.debug("[moveToPointOnArc] 3 -> normal vector calculation \n");
            //var vn = getNormalVector(centerPoint,currentPoint,newPoint);
            //vn = normalizeVector(vn);
            artnetutils.tracePoint("normalVector ", vn);
            var backVector = utils.rotatePoint_xy_quarterion(utils.OZ, vn);
            artnetutils.tracePoint("BackVector", backVector);
            this.debug("[moveToPointOnArc] *************************************");

            this.debug("[moveToPointOnArc] 4 -> rotate coordinate system \n");
            currentPoint = utils.rotatePoint_xy_quarterion(currentPoint, vn);
            newPoint = utils.rotatePoint_xy_quarterion(newPoint, vn);
            centerPoint = utils.rotatePoint_xy_quarterion(centerPoint, vn);

            artnetutils.tracePoint("currentPoint ", currentPoint);
            artnetutils.tracePoint("newPoint     ", newPoint);
            artnetutils.tracePoint("centerPoint  ", centerPoint);
            this.debug("[moveToPointOnArc] *************************************");


            this.debug("[moveToPointOnArc] 4.1 -> rotate coordinate system back for check\n");
            var currentPoint1 = utils.rotatePoint_xy_quarterion(currentPoint, backVector);
            var newPoint1 = utils.rotatePoint_xy_quarterion(newPoint, backVector);
            var centerPoint1 = utils.rotatePoint_xy_quarterion(centerPoint, backVector);

            artnetutils.tracePoint("currentPoint1 ", currentPoint1);
            artnetutils.tracePoint("newPoint1     ", newPoint1);
            artnetutils.tracePoint("centerPoint1  ", centerPoint1);
            this.debug("[moveToPointOnArc] *************************************");

            var radius = utils.getDistanceBetweenPointsInCartesian(currentPoint, centerPoint);
            var radius2 = utils.getDistanceBetweenPointsInCartesian(newPoint, centerPoint);
            if (Math.abs(radius2 - radius) > utils.EPSILON) {
                this.error("[moveToPointOnArc] Invalid center point");
                return;
            }
            this.debug("[moveToPointOnArc] 5 -> parametric equation startT and endT calculation \n");
            //find t parameter for start and end point
            var currentT = (Math.acos(currentPoint.x / radius) + 2 * Math.PI) % (2 * Math.PI);
            var newT = (Math.acos(newPoint.x / radius) + 2 * Math.PI) % (2 * Math.PI);
            this.debug("[moveToPointOnArc] T parameters rad", radius, currentT, newT);
            this.debug("[moveToPointOnArc] T parameters degree", utils.radiansToDegrees(currentT), utils.radiansToDegrees(newT));
            this.debug("[moveToPointOnArc] *************************************");

            var actualAngle = newT - currentT;
            var angleDelta = Math.abs(actualAngle) <= Math.PI ? actualAngle : -(actualAngle - Math.PI);

            var steps = transition_time / this.resolution;
            var time_per_step = this.resolution;
            var angleStep = angleDelta / steps;
            // limit steps for interval
            var startStep = parseInt(steps * interval.start);
            var endStep = parseInt(steps * interval.end);
            this.debug("[moveToPointOnArc] angleStep", angleDelta, angleStep, utils.radiansToDegrees(angleDelta));
            this.debug("[moveToPointOnArc] angleStep", steps, startStep, endStep);

            var timeoutID;
            var counter = 0;

            for (var i = startStep; i <= endStep; i++) {
                var t = currentT + i * angleStep;
                timeoutID = setTimeout(function (t) {
                    // get point in spherical coordinates
                    var iterationPoint = utils.getIterationPoint(t, self.radius, self.backVector, self.movement_point);
                    var tilt = artnetutils.validateChannelValue(artnetutils.radToChannelValue(iterationPoint.theta, self.arcConfig.tilt_angle));
                    var pan = artnetutils.validateChannelValue(artnetutils.radToChannelValue(iterationPoint.phi, self.arcConfig.pan_angle));

                    self.debug("[moveToPointOnArc] sphericalP     ", "r: ", parseFloat(iterationPoint.r).toFixed(4), "theta:", parseFloat(iterationPoint.theta).toFixed(4), "phi:", parseFloat(iterationPoint.phi).toFixed(4), "\n",
                        "T:             ", parseFloat(t).toFixed(4), "\n",
                        "TILT: ", tilt, "pan: ", pan);
                        this.debug("[moveToPointOnArc] **********************");

                        self.set(self.arcConfig.tilt_channel, tilt);
                        self.set(self.arcConfig.pan_channel, pan);
                        this.sendData();
                }.bind(mode), counter * time_per_step, t);
                counter++;
                this.addTransitionTimeout(arcConfig.pan_channel, timeoutID);
                this.addTransitionTimeout(arcConfig.tilt_channel, timeoutID);
            }

            if (endStep == 1) {
                var tilt = artnetutils.validateChannelValue(artnetutils.radToChannelValue(nv_theta, arcConfig.tilt_angle));
                var pan = artnetutils.validateChannelValue(artnetutils.radToChannelValue(nv_phi, arcConfig.pan_angle));

                timeoutID = setTimeout(function () {
                    self.set(arcConfig.tilt_channel, tilt);
                    self.set(arcConfig.pan_channel, pan);
                    self.sendData();
                    delete self.closeCallbacksMap[arcConfig.tilt_channel];
                    delete self.closeCallbacksMap[arcConfig.pan_channel];
                }, transition_time);

                this.addTransitionTimeout(arcConfig.pan_channel, timeoutID);
                this.addTransitionTimeout(arcConfig.tilt_channel, timeoutID);

                // add close callback to set channels to new_value in case redeploy and all timeouts stopping
                this.closeCallbacksMap[arcConfig.pan_channel] = this.closeCallbacksMap[arcConfig.tilt_channel] = (function () {
                    this.set(arcConfig.tilt_channel, tilt);
                    this.set(arcConfig.pan_channel, pan);
                });
            }
        };

        this.on('close', function() {
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