// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
function packages(path) {
	let data = json(readfile(path));
	let rows = type(data) == 'array' ? data : data.packages;
	if (type(rows) != 'array') die('Unexpected APK query format');
	return rows;
}
let installed = {};
for (let row in packages(ARGV[1])) installed[row.name] = row.version;
let bytes = 0, download = 0;
for (let row in packages(ARGV[0])) {
	if (installed[row.name] == row.version) continue;
	if (type(row['installed-size']) != 'int' || type(row['file-size']) != 'int'
		|| row['installed-size'] < 0 || row['file-size'] < 0) die('Missing package sizes');
	bytes += row['installed-size']; download += row['file-size'];
}
printf('%.0f %.0f\n', bytes, download);
