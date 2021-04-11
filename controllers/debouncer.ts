import { EventEmitter } from "events";

export class Debouncer extends EventEmitter {

    private state: boolean;
    private lastMs: number;

    constructor(private debounceDuration = 50) {
        super();
        this.state = false;
        this.lastMs = +Date.now();
    }

    check(newValue: boolean, millis = +Date.now()): void {
        if (millis - this.lastMs > this.debounceDuration && this.state != newValue) {
            this.lastMs = millis;
            this.state = newValue;

            this.emit('change', this.state);
        }
    }
}