export class Utils {
    static mod(n, m): number {
        return ((n % m) + m) % m;
    }
}