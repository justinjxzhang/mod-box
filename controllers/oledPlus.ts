import { Utils } from '../utils';
import Oled from '../../oled-js/oled';
import * as oledfont5x7 from 'oled-font-5x7'


export class OledPlus extends Oled {
    drawList<T1, T2>(x: number, y: number, itemsPerPage: number, items: T1[], selected: T2, nameGetter: (v: T1) => string, compare: (a: T1, b: T2) => boolean) {
        const selectedIndex = items.findIndex(i => compare(i, selected));
        const selectedIndexPage = Utils.mod(selectedIndex, itemsPerPage);
        const currentPage = Math.floor(selectedIndex / itemsPerPage);
        const pageItems = items.filter((item, index) => index >= itemsPerPage * currentPage && index < itemsPerPage * currentPage + itemsPerPage);

        this.fillRect(x, y, 128, itemsPerPage * 10, 0x00, false);

        this.setCursor(x, y);
        pageItems.forEach((pageItem, idx) => {
            const displayString = `${idx === selectedIndexPage ? '* ' : '  '}${nameGetter(pageItem)}`;
            this.setCursor(x, (idx * 10) + y);
            this.writeString(oledfont5x7, 1, displayString, 0x01, false, 1, false);
        });
    }
}