"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * homebridge-rpi-garagedoor
 * A simple Raspberry Pi Garage Door Opener/Closer Plugin for Homebridge.
 * Cory Mayer
 *
 * Note: I hackish-ly created interfaces for homebridge classes because I didn't
 * have time to make type definitions for TypeScript. Sorry.
 */
var RPIO = require("rpio");
/**
 * Base class that represents a plugin for Homebridge.
 *
 * @abstract
 * @class HomebridgePlugin
 */
var HomebridgePlugin = /** @class */ (function () {
    function HomebridgePlugin(log, config) {
        // IMPLEMENTME
    }
    return HomebridgePlugin;
}());
/**
 * Config json structure for my plugin.
 *
 * @class RPGConfig
 */
var RPGConfig = /** @class */ (function () {
    function RPGConfig() {
    }
    return RPGConfig;
}());
/**
 * Entry point for the plugin.
 */
module.exports = function (api) {
    HomebridgePlugin.api = api;
    api.registerAccessory('homebridge-rpi-garagedoor', 'RPIGarageDoor', GarageDoorAccessory);
};
/**
 * Class that represents a Homebridge accessory for controlling
 * a simple garage door opener. Handles all states of a typical
 * garage door opener.
 *
 * @class GarageDoorAccessory
 * @implements {HomebridgePlugin}
 */
var GarageDoorAccessory = /** @class */ (function (_super) {
    __extends(GarageDoorAccessory, _super);
    /**
     * Sets up the plugin and all of its services.
     * @param {HBLogFunc} log the plugin's logger function
     * @param {RPGConfig} config the configuration from config.json
     *
     * @memberof GarageDoorAccessory
     */
    function GarageDoorAccessory(log, config) {
        var _this = _super.call(this, log, config) || this;
        _this.MANUFACTURER = 'Homebridge';
        _this.MODEL = 'Garage Opener';
        _this.SERIAL = '8675309';
        _this.DEFAULT_DOOR_PIN = 12;
        _this.DEFAULT_TIME_OPEN = 10;
        _this.DEFAULT_BTN_HOLD_TIME = 0.1;
        _this.MS_IN_S = 1000;
        _this.log = log;
        // parse config json
        _this.config = new RPGConfig();
        _this.config.name = config['name'];
        _this.config.doorPin = config['doorPin'] || _this.DEFAULT_DOOR_PIN;
        _this.config.timeToOpen = config['timeToOpen'] || _this.DEFAULT_TIME_OPEN;
        _this.config.buttonHoldTime = config['buttonHoldTime'] || _this.DEFAULT_BTN_HOLD_TIME;
        log("initialized with pin [" + _this.config.doorPin + "], tOpen ["
            + _this.config.timeToOpen + "] buttonTime ["
            + _this.config.buttonHoldTime + "]");
        // bad way of accessing hap-nodejs API but required by homebridge
        var Service = HomebridgePlugin.api.hap.Service;
        var Characteristic = HomebridgePlugin.api.hap.Characteristic;
        _this.services = [];
        // create opener service
        _this.openerService = new Service.GarageDoorOpener(_this.config.name, _this.config.name);
        _this.configOpenerService();
        _this.services.push(_this.openerService);
        // create accessory service
        _this.services.push(new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, _this.MANUFACTURER)
            .setCharacteristic(Characteristic.Model, _this.MODEL)
            .setCharacteristic(Characteristic.SerialNumber, _this.SERIAL));
        return _this;
    }
    /**
     * Main logic for the plugin that configures what happens
     * when various callbacks occur on the service.
     *
     * @memberof GarageDoorAccessory
     */
    GarageDoorAccessory.prototype.configOpenerService = function () {
        var _this = this;
        var service = this.openerService;
        // create the rpio pin for door control, set pulldown resistor
        if (process.env.DEBUG != '*') {
            RPIO.open(this.config.doorPin, RPIO.OUTPUT, RPIO.LOW);
        }
        // more hackish hap-nodejs api access
        var CurrentDoorState = HomebridgePlugin.api.hap.Characteristic.CurrentDoorState;
        var TargetDoorState = HomebridgePlugin.api.hap.Characteristic.TargetDoorState;
        // set initial door state
        service.setCharacteristic(CurrentDoorState, CurrentDoorState.CLOSED);
        service.setCharacteristic(TargetDoorState, TargetDoorState.CLOSED);
        // setup service callback for monitoring state
        service.getCharacteristic(TargetDoorState).on('get', function (callback) {
            var curValue = service.getCharacteristic(TargetDoorState).value;
            _this.log("GET TARGET: " + curValue);
            callback(null, curValue);
        });
        service.getCharacteristic(TargetDoorState).on('set', function (newValue, callback) {
            // first get the current state
            var currentState = service.getCharacteristic(CurrentDoorState).value;
            switch (newValue) {
                // TARGET = OPENED
                case TargetDoorState.OPEN:
                    _this.log("Target is OPENING");
                    if (currentState == CurrentDoorState.CLOSED ||
                        currentState == CurrentDoorState.CLOSING) {
                        // start opening the door
                        _this.toggleDoor();
                        _this.setState(CurrentDoorState.OPENING);
                        _this.log("Door OPENING");
                        // set a timer to set the door as open when it is done
                        _this.timer = global.setTimeout(function () {
                            // make sure door is still opening
                            if (_this.getState() == CurrentDoorState.OPENING) {
                                _this.setState(CurrentDoorState.OPEN);
                                _this.log("Door is OPEN");
                            }
                        }, _this.config.timeToOpen * _this.MS_IN_S);
                    }
                    else if (currentState == CurrentDoorState.OPEN) {
                        // don't do anything because it's already open
                        _this.log("Door already OPEN");
                    }
                    else if (currentState == CurrentDoorState.STOPPED) {
                        // If the door is opening, we stop it, and resume from
                        // a stop, iOS insists the next direction should be open.
                        // Since we can't override this, we just have to do a 
                        // noop here to match the actual door operation.
                        // Users will have to tap twice to resume.
                    }
                    else {
                        // if door is opening then stop the door
                        _this.toggleDoor();
                        _this.setState(CurrentDoorState.STOPPED);
                        _this.log("Door STOPPED");
                    }
                    break;
                // TARGET = CLOSED
                case TargetDoorState.CLOSED:
                    _this.log("Target is CLOSING");
                    if (currentState == CurrentDoorState.OPEN ||
                        currentState == CurrentDoorState.STOPPED) {
                        // start closing the door
                        _this.toggleDoor();
                        _this.setState(CurrentDoorState.CLOSING);
                        _this.log("Door CLOSING");
                        // set a timer to set the door as closed when it is done
                        _this.timer = global.setTimeout(function () {
                            // make sure door is still closing
                            if (_this.getState() == CurrentDoorState.CLOSING) {
                                _this.setState(CurrentDoorState.CLOSED);
                                _this.log("Door is CLOSED");
                            }
                        }, _this.config.timeToOpen * _this.MS_IN_S);
                    }
                    else if (currentState == CurrentDoorState.CLOSED) {
                        // don't do anything, already closed
                        _this.log("Door is already CLOSED");
                    }
                    else {
                        // if door is closing or opening then stop the door
                        _this.toggleDoor();
                        _this.setState(CurrentDoorState.STOPPED);
                        _this.log("Door STOPPED");
                    }
                    break;
            }
            // call the callback because the hap-nodejs documentation says so
            callback();
        });
        // setup service to send state back to device
        service.getCharacteristic(CurrentDoorState).on('get', function (callback) {
            _this.log("GET STATE: " + _this.getState());
            callback(null, _this.getState());
        });
    };
    /**
     * Helper function to set the CurrentDoorState.
     * @param {*} state the CurrentDoorState to set on the service
     *
     * @memberof GarageDoorAccessory
     */
    GarageDoorAccessory.prototype.setState = function (state) {
        var CurrentDoorState = HomebridgePlugin.api.hap.Characteristic.CurrentDoorState;
        this.openerService.setCharacteristic(CurrentDoorState, state);
    };
    GarageDoorAccessory.prototype.setTargetState = function (state) {
        var TargetDoorState = HomebridgePlugin.api.hap.Characteristic.TargetDoorState;
        this.openerService.setCharacteristic(TargetDoorState, state);
    };
    /**
     * Helper function to get the CurrentDoorState.
     * @returns {*} the CurrentDoorState of the service
     *
     * @memberof GarageDoorAccessory
     */
    GarageDoorAccessory.prototype.getState = function () {
        var CurrentDoorState = HomebridgePlugin.api.hap.Characteristic.CurrentDoorState;
        return this.openerService.getCharacteristic(CurrentDoorState).value;
    };
    /**
     * Simulates pressing the garage door push button by turning
     * on the transistor that bridges the push button terminals
     * for a breif time.
     *
     * @memberof GarageDoorAccessory
     */
    GarageDoorAccessory.prototype.toggleDoor = function () {
        if (process.env.DEBUG == '*') {
            this.log("TOGGLE");
        }
        else {
            RPIO.write(this.config.doorPin, RPIO.HIGH);
            RPIO.sleep(this.config.buttonHoldTime);
            RPIO.write(this.config.doorPin, RPIO.LOW);
        }
    };
    /**
     * Gets all of the services associated with this plugin.
     * @returns {any[]} an array of Services
     *
     * @memberof GarageDoorAccessory
     */
    GarageDoorAccessory.prototype.getServices = function () {
        return this.services;
    };
    return GarageDoorAccessory;
}(HomebridgePlugin));
