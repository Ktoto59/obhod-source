// SPDX-License-Identifier: Apache-2.0
// Object key order and formatting are irrelevant; array order is significant.
import { readfile } from 'fs';
function equal(a, b) {
    if (type(a) != type(b)) return false;
    if (type(a) == 'array') {
        if (length(a) != length(b)) return false;
        for (let i = 0; i < length(a); i++) if (!equal(a[i], b[i])) return false;
        return true;
    }
    if (type(a) == 'object') {
        if (length(keys(a)) != length(keys(b))) return false;
        for (let key in keys(a)) if (!(key in b) || !equal(a[key], b[key])) return false;
        return true;
    }
    return a == b;
}
exit(equal(json(readfile(ARGV[0])), json(readfile(ARGV[1]))) ? 0 : 1);
