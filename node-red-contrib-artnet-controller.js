//const artnet = require('artnet-node');
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
// wegen backtick this.log(`artnetcontroller: ${JSON.stringify(this.controllerObj.lname)}`);

module.exports = function (RED) {

    // Config node for the Art-Net Controller
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

        // create controller instance
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

        this.on('close', function() {
            // put this into the dmxnet lib 
            this.dmxnet.listener4.close();
            delete this.dmxnet;
        });
    }
    RED.nodes.registerType("Art-Net Controller", ArtNetController);

    // Config node for holding a universe and having the functionality
    // of automatic and timed value transformation
    function ArtNetSender(config) {
        RED.nodes.createNode(this, config);
        this.name             = config.name       || '';
        this.artnetcontroller = config.artnetcontroller;
        this.address          = config.address    || '255.255.255.255';
        this.port             = config.port       || 6454;
        this.net              = config.net        || 0;
        this.subnet           = config.subnet     || 0;
        this.universe         = config.universe   || 0;
        this.refresh          = config.refresh    || 1000;
        this.savevalues       = typeof config.savevalues === 'undefined' ? true : config.savevalues;

        this.controllerObj = RED.nodes.getNode(this.artnetcontroller);
        /*
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
*/
        this.nodeContext = this.context().global;
        this.contextData = this.nodeContext.get(this.id) || {};

        this.dmxData = this.savevalues ? this.contextData.dmxData || [] : [];
        if (this.dmxData.length !== 512) {
            this.dmxData = new Array(512).fill(0);
            this.trace('filling, now: ' + this.dmxData.length);
        }
        this.nodeContext.set(this.id, {'dmxData': this.dmxData});

        for (var i = 0; i < 512; i++) {
            this.sender.prepChannel(i, this.dmxData[i]);
        }
        // initial transmission
        this.sender.transmit();
        this.log('initial transmit');
        
        this.closeCallbacksMap = {};
        this.transitionsMap = {};

        // functions following
        var node = this;
		
        this.saveDataToContext = function () {
            this.nodeContext.set(this.id, {'dmxData': this.dmxData});
        };

        this.sendData = function () {
            this.sender.transmit();
            this.log('transmit');
        };

        this.setChannelValue = function (channel, value) {
            node.set(channel, value);
            node.sendData();
        };

        // region transition map logic
        // called on close node
        this.clearTransitions = function () {
            for (var channel in node.transitionsMap) {
                if (node.transitionsMap.hasOwnProperty(channel)) {
                    node.clearTransition(channel);
                }
            }
            // reset maps
            node.transitionsMap = {};
            node.closeCallbacksMap = {};
        };
        this.clearTransition = function (channel, skipDataSending) {
            var transition = node.transitionsMap[channel];
            // cancel all timeouts
            if (transition && transition.timeouts) {
                for (var i = 0; i < transition.timeouts.length; i++) {
                    clearTimeout(transition.timeouts[i]);
                }
                transition.timeouts.length = 0;
            }
            // finish transition immediately
            if (node.closeCallbacksMap.hasOwnProperty(channel)) {
                node.closeCallbacksMap[channel]();
                // skip data sending if we have start_buckets in payload
                if (!skipDataSending) {
                    node.sendData();
                }
                delete node.closeCallbacksMap[channel];
            }
            // remove transition from map
            delete node.transitionsMap[channel];
        };
        this.addTransition = function (channel, transition, value) {
            artnetutils.log("Add transition", channel, value);
            node.clearTransition(channel);
            var transitionItem = {"transition": transition, "timeouts": []};
            if (value) {
                transitionItem.value = parseInt(value);
            }
            node.transitionsMap[channel] = transitionItem;
        };
        this.addTransitionTimeout = function (channel, timeoutId) {
            var transition = node.transitionsMap[channel];
            if (transition) {
                transition.timeouts.push(timeoutId);
            }
        };
        //endregion

        this.set = function (address, value, transition, transition_time) {
            if (address > 0) {
                if (transition) {
                    node.addTransition(address, transition, value); //TODO move to input
                    node.fadeToValue(address, parseInt(value), transition_time);
                } else {
                    node.dmxData[address - 1] = artnetutils.roundChannelValue(value);
                    node.sender.prepChannel(address - 1, artnetutils.roundChannelValue(value));
                }
            }
        };

        this.get = function (address) {
            return parseInt(node.dmxData[address - 1] || 0);
        };

        this.input = function(msg) { 
        //this.on('input', function (msg) {
            var payload = msg.payload;
            var transition = payload.transition;
            var duration = parseInt(payload.duration || 0);
            var i = 0;

            //node.universe = payload.universe || config.universe || 0;
            //node.client.UNIVERSE = [node.universe, 0];

            if (payload.start_buckets && Array.isArray(payload.start_buckets)) {
                for (i = 0; i < payload.start_buckets.length; i++) {
                    node.clearTransition(payload.start_buckets[i].channel, true);
                    // skip data sending to device
                    node.set(payload.start_buckets[i].channel, payload.start_buckets[i].value);
                }
                node.sendData();
            }

            if (transition === "arc") {
                try {
                    if (!payload.end || !payload.center) {
                        node.error("Invalid payload");
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
                    node.addTransition(arcConfig.tilt_channel, "arc");
                    node.addTransition(arcConfig.pan_channel, "arc");

                    node.moveToPointOnArc(cv_theta, cv_phi,
                        payload.end.tilt, payload.end.pan,
                        payload.center.tilt, payload.center.pan,
                        duration, interval, arcConfig);
                } catch (e) {
                    artnetutils.log("ERROR " + e.message);
                }
            } else {
                if (payload.channel) {
                    node.set(payload.channel, payload.value, transition, duration);
                } else if (Array.isArray(payload.buckets)) {
                    for (i = 0; i < payload.buckets.length; i++) {
                        node.clearTransition(payload.buckets[i].channel, true);
                        node.set(payload.buckets[i].channel, payload.buckets[i].value, transition, duration);
                    }
                    if (!transition) {
                        node.sendData();
                    }
                } else {
                    node.error("Invalid payload buckets");
                }
            }
        };
        //});

        this.fadeToValue = function (channel, new_value, transition_time) {
            var oldValue = node.get(channel);
            var steps = transition_time / node.rate;

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
                    this.node.setChannelValue(this.channel, Math.round(val));
                }.bind(node), i * time_per_step, iterationValue);
                node.addTransitionTimeout(channel, timeoutID);
            }

            // add close callback to set channels to new_value in case redeploy and all timeouts stopping
            node.closeCallbacksMap[channel] = (function () {
                node.set(channel, new_value);
            });

            timeoutID = setTimeout(function () {
                node.setChannelValue(channel, new_value);
                // clear channel transition on last iteration
                node.clearTransition(channel);
            }, transition_time);
            node.addTransitionTimeout(channel, timeoutID);
        };

        this.moveToPointOnArc = function (_cv_theta, _cv_phi, _tilt_nv, _pan_nv, _tilt_center, _pan_center, transition_time, interval, arcConfig) {
            // current value
            var cv_theta = artnetutils.channelValueToRad(_cv_theta, arcConfig.tilt_angle); //tilt
            var cv_phi = artnetutils.channelValueToRad(_cv_phi, arcConfig.pan_angle); // pan

            // target value
            var nv_theta = artnetutils.channelValueToRad(_tilt_nv, arcConfig.tilt_angle);
            var nv_phi = artnetutils.channelValueToRad(_pan_nv, arcConfig.pan_angle);

            // center value
            var tilt_center = artnetutils.channelValueToRad(_tilt_center, arcConfig.tilt_angle); //tilt
            var pan_center = artnetutils.channelValueToRad(_pan_center, arcConfig.pan_angle); // pan

            artnetutils.log("Input points ", "\n curPoint:", cv_theta, cv_phi, "\n " +
                "newPoint: ", nv_theta, nv_phi, "\n" +
                "newPoint2: ", utils.radiansToDegrees(nv_theta), utils.radiansToDegrees(nv_phi), "\n" +
                "centerPoint: ", tilt_center, pan_center);
            artnetutils.log("*************************************");
            // convert points to Cartesian coordinate system
            artnetutils.log("1 -> convert  points to cartesian \n");
            var currentPoint = utils.toCartesian({phi: cv_phi, theta: cv_theta});
            var newPoint = utils.toCartesian({phi: nv_phi, theta: nv_theta});
            var centerPoint = utils.toCartesian({phi: pan_center, theta: tilt_center});
            var vn = centerPoint;
            vn = utils.normalizeVector(vn);
            centerPoint = utils.calcCenterPoint(centerPoint, currentPoint);

            artnetutils.tracePoint("currentPoint ", currentPoint);
            artnetutils.tracePoint("newPoint     ", newPoint);
            artnetutils.tracePoint("centerPoint  ", centerPoint);
            artnetutils.log("*************************************");
            var movement_point = centerPoint;

            // move center of circle to center of coordinates
            artnetutils.log("2 -> move to O(0,0,0) \n");
            currentPoint = utils.movePointInCartesian(currentPoint, centerPoint, -1);
            newPoint = utils.movePointInCartesian(newPoint, centerPoint, -1);
            centerPoint = utils.movePointInCartesian(centerPoint, centerPoint, -1);
            artnetutils.tracePoint("currentPoint ", currentPoint);
            artnetutils.tracePoint("newPoint     ", newPoint);
            artnetutils.tracePoint("centerPoint  ", centerPoint);
            artnetutils.log("*************************************");

            // calculate normal vector (i,j,k) for circle plane (three points)
            artnetutils.log("3 -> normal vector calculation \n");
            //var vn = getNormalVector(centerPoint,currentPoint,newPoint);
            //vn = normalizeVector(vn);
            artnetutils.tracePoint("normalVector ", vn);
            var backVector = utils.rotatePoint_xy_quarterion(utils.OZ, vn);
            artnetutils.tracePoint("BackVector", backVector);
            artnetutils.log("*************************************");

            artnetutils.log("4 -> rotate coordinate system \n");
            currentPoint = utils.rotatePoint_xy_quarterion(currentPoint, vn);
            newPoint = utils.rotatePoint_xy_quarterion(newPoint, vn);
            centerPoint = utils.rotatePoint_xy_quarterion(centerPoint, vn);

            artnetutils.tracePoint("currentPoint ", currentPoint);
            artnetutils.tracePoint("newPoint     ", newPoint);
            artnetutils.tracePoint("centerPoint  ", centerPoint);
            artnetutils.log("*************************************");


            artnetutils.log("4.1 -> rotate coordinate system back for check\n");
            var currentPoint1 = utils.rotatePoint_xy_quarterion(currentPoint, backVector);
            var newPoint1 = utils.rotatePoint_xy_quarterion(newPoint, backVector);
            var centerPoint1 = utils.rotatePoint_xy_quarterion(centerPoint, backVector);

            artnetutils.tracePoint("currentPoint1 ", currentPoint1);
            artnetutils.tracePoint("newPoint1     ", newPoint1);
            artnetutils.tracePoint("centerPoint1  ", centerPoint1);
            artnetutils.log("*************************************");

            var radius = utils.getDistanceBetweenPointsInCartesian(currentPoint, centerPoint);
            var radius2 = utils.getDistanceBetweenPointsInCartesian(newPoint, centerPoint);
            if (Math.abs(radius2 - radius) > utils.EPSILON) {
                node.error("Invalid center point");
                return;
            }
            artnetutils.log("5 -> parametric equation startT and endT calculation \n");
            //find t parameter for start and end point
            var currentT = (Math.acos(currentPoint.x / radius) + 2 * Math.PI) % (2 * Math.PI);
            var newT = (Math.acos(newPoint.x / radius) + 2 * Math.PI) % (2 * Math.PI);
            artnetutils.log("T parameters rad", radius, currentT, newT);
            artnetutils.log("T parameters degree", utils.radiansToDegrees(currentT), utils.radiansToDegrees(newT));
            artnetutils.log("*************************************");

            var actualAngle = newT - currentT;
            var angleDelta = Math.abs(actualAngle) <= Math.PI ? actualAngle : -(actualAngle - Math.PI);

            var steps = transition_time / node.rate;
            var time_per_step = node.rate;
            var angleStep = angleDelta / steps;
            // limit steps for interval
            var startStep = parseInt(steps * interval.start);
            var endStep = parseInt(steps * interval.end);
            artnetutils.log("angleStep", angleDelta, angleStep, utils.radiansToDegrees(angleDelta));
            artnetutils.log("angleStep", steps, startStep, endStep);

            var timeoutID;
            var counter = 0;

            for (var i = startStep; i <= endStep; i++) {
                var t = currentT + i * angleStep;
                timeoutID = setTimeout(function (t) {
                    // get point in spherical coordinates
                    var iterationPoint = utils.getIterationPoint(t, this.radius, this.backVector, this.movement_point);
                    var tilt = artnetutils.validateChannelValue(artnetutils.radToChannelValue(iterationPoint.theta, this.arcConfig.tilt_angle));
                    var pan = artnetutils.validateChannelValue(artnetutils.radToChannelValue(iterationPoint.phi, this.arcConfig.pan_angle));

                    artnetutils.log("sphericalP     ", "r: ", parseFloat(iterationPoint.r).toFixed(4), "theta:", parseFloat(iterationPoint.theta).toFixed(4), "phi:", parseFloat(iterationPoint.phi).toFixed(4), "\n",
                        "T:             ", parseFloat(t).toFixed(4), "\n",
                        "TILT: ", tilt, "pan: ", pan);
                    artnetutils.log("**********************");

                    this.node.set(this.arcConfig.tilt_channel, tilt);
                    this.node.set(this.arcConfig.pan_channel, pan);
                    this.node.sendData();
                }.bind(mode), counter * time_per_step, t);
                counter++;
                node.addTransitionTimeout(arcConfig.pan_channel, timeoutID);
                node.addTransitionTimeout(arcConfig.tilt_channel, timeoutID);
            }

            if (endStep == 1) {
                var tilt = artnetutils.validateChannelValue(artnetutils.radToChannelValue(nv_theta, arcConfig.tilt_angle));
                var pan = artnetutils.validateChannelValue(artnetutils.radToChannelValue(nv_phi, arcConfig.pan_angle));

                timeoutID = setTimeout(function () {
                    node.set(arcConfig.tilt_channel, tilt);
                    node.set(arcConfig.pan_channel, pan);
                    node.sendData();
                    delete node.closeCallbacksMap[arcConfig.tilt_channel];
                    delete node.closeCallbacksMap[arcConfig.pan_channel];
                }, transition_time);

                node.addTransitionTimeout(arcConfig.pan_channel, timeoutID);
                node.addTransitionTimeout(arcConfig.tilt_channel, timeoutID);

                // add close callback to set channels to new_value in case redeploy and all timeouts stopping
                node.closeCallbacksMap[arcConfig.pan_channel] = node.closeCallbacksMap[arcConfig.tilt_channel] = (function () {
                    node.set(arcConfig.tilt_channel, tilt);
                    node.set(arcConfig.pan_channel, pan);
                });
            }
        };

        this.on('close', function() {
            node.clearTransitions();
            node.saveDataToContext();
            this.sender.stop();
            delete this.sender;
        });
    }
    RED.nodes.registerType("Art-Net Sender", ArtNetSender);

    // The out node for sending data in a flow
    function ArtNetOutNode(config) {
        RED.nodes.createNode(this, config);
        this.name             = config.name       || '';
        this.artnetsender     = config.artnetsender;
        this.ignoreaddress    = typeof config.ignoreaddress === 'undefined' ? false : config.ignoreaddress;

        this.senderObject =  RED.nodes.getNode(this.artnetsender);
        this.controllerObj = RED.nodes.getNode(this.senderObject.artnetcontroller);

        this.log(`senderObject: ${this.senderObject}, controllerObj: ${this.controllerObj}`);

        this.on('input', function (msg) {
            this.trace(`get payload: ${JSON.stringify(msg.payload, null, 2)}`);
            var payload = msg.payload;
            var locNet, locSubnet, locUniverse;
            // check if ignore address is set
            if (this.ignoreaddress) {
                this.debug(`ignore address is set, routing to default sender`);
                this.senderObject.input(msg);
                return;
            }
            // check if address information in payload
            if ((payload.net === undefined) && (payload.subnet === undefined) && (payload.universe === undefined)) {
                this.debug(`no address information found, routing to default sender`);
                this.senderObject.input(msg);
                return;
            }
            // ok there if address information, now check each value
            if (payload.net !== undefined) {
                if ((parseInt(payload.net) < 0) || (parseInt(payload.net) > 15)) {
                    this.warn(`invalid net in payload: ${payload.net}`);
                    locNet = this.senderObject.net;
                } else {
                    locNet = parseInt(payload.net);
                }
            } else {
                locNet = this.senderObject.net;
            }
            if (payload.subnet !== undefined) {
                if ((parseInt(payload.subnet) < 0) || (parseInt(payload.subnet) > 15)) {
                    this.warn(`invalid net in payload: ${payload.subnet}`);
                    locSubnet = this.senderObject.subnet;
                } else {
                    locSubnet = parseInt(payload.subnet);
                }
            } else {
                locSubnet = this.senderObject.net;
            }
            if (payload.universe !== undefined) {
                if ((parseInt(payload.universe) < 0) || (parseInt(payload.universe) > 15)) {
                    this.warn(`invalid universe in payload: ${payload.universe}`);
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
                this.debug(`${locNet}:${locSubnet}:${locUniverse}, routing to sender: ${locSender}`);
                RED.nodes.getNode(locSender).input(msg);
            } else {
                this.warn(`no sender found for specified address information: ${locNet}:${locSubnet}:${locUniverse}, routing to default sender`);
                this.senderObject.input(msg);
            }
        });

    }
    RED.nodes.registerType("Art-Net Out", ArtNetOutNode);

    // ArtNetInNode is like ArtNetReceiver (in dmxnet speech)
    function ArtNetInNode(config) {
        RED.nodes.createNode(this, config);
    }
    RED.nodes.registerType("Art-Net In", ArtNetInNode);

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