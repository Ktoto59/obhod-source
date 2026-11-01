const test = require('node:test');
const assert = require('node:assert/strict');
const {defaultRouterProfile,generateRouterConfig} = require('../openwrt/lib/config');
const {parseProxyUri} = require('../shared/profile');

test('router intercepts standard TCP/UDP DNS before domain/private routes, including stale TUN DNS addresses',()=>{
  const profile=defaultRouterProfile();
  profile.tunnels=[parseProxyUri('socks5://192.0.2.10:1080')];
  profile.routing.activeTunnelId=profile.tunnels[0].id;
  profile.routing.localLists=[{id:'selected',name:'Selected',enabled:true,domains:['selected.example'],cidrs:[]}];
  const config=generateRouterConfig(profile);
  const guard=config.route.rules.findIndex(r=>r.action==='hijack-dns' && r.port===53);
  assert.ok(guard>=0);
  assert.deepEqual(config.route.rules[guard].inbound,['tun-in']);
  assert.deepEqual(config.route.rules[guard].network,['tcp','udp']);
  assert.ok(guard<config.route.rules.findIndex(r=>r.domain_suffix));
  assert.ok(guard<config.route.rules.findIndex(r=>r.ip_is_private));
  assert.ok(!config.route.rules.some(r=>r.action==='hijack-dns' && r.protocol==='dns'));
});
