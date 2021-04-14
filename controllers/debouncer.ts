import { EventEmitter } from "events";

export class Debouncer extends EventEmitter {

    static CLICK = 'click';
    static HELD = 'held';

    private state: boolean;
    private lastMs: number;

    private heldTimeout?: NodeJS.Timeout;

    constructor(private debounceDuration = 50, private holdDuration = 300) {
        super();
        this.state = false;
        this.lastMs = +Date.now();
    }

    check(newValue: boolean, millis = +Date.now()): void {
        if (millis - this.lastMs > this.debounceDuration && this.state != newValue) {
            if (newValue == true) {
                this.heldTimeout = setTimeout(() => {
                    this.emit(Debouncer.HELD);
                    this.heldTimeout = null;
                }, this.holdDuration);
            }

            if (newValue == false) {
                if (this.heldTimeout != null) {
                    clearTimeout(this.heldTimeout);
                    this.heldTimeout = null;
                    this.emit(Debouncer.CLICK);
                }
            }

            this.lastMs = millis;
            this.state = newValue;
        }
    }
}