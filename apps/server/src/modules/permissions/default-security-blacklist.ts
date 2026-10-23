import { ActionId } from './permission-types.js';
import type { InterventionRule } from './intervention-checker.js';

/**
 * Каталог правил security blacklist по умолчанию.
 *
 * Каждая запись — константное правило source-catalogue: matcher применяется к
 * канонической строке `JSON.stringify([executableBasename, ...argv])`, effect
 * фиксирован как `ABSOLUTE_DENY`, `reasonCode` равен `id` правила.
 * Каталог является фиксированным дополнительным guard'ом, а не исчерпывающей
 * security policy и не OS sandbox.
 */
export const DEFAULT_SECURITY_BLACKLIST: readonly InterventionRule[] = Object.freeze([
  {
    id: 'cmd-rm-recursive-r',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","-r",' },
    reasonCode: 'cmd-rm-recursive-r',
  },
  {
    id: 'cmd-rm-recursive-R',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","-R",' },
    reasonCode: 'cmd-rm-recursive-R',
  },
  {
    id: 'cmd-rm-rf',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","-rf",' },
    reasonCode: 'cmd-rm-rf',
  },
  {
    id: 'cmd-rm-fr',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","-fr",' },
    reasonCode: 'cmd-rm-fr',
  },
  {
    id: 'cmd-rm-Rf',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","-Rf",' },
    reasonCode: 'cmd-rm-Rf',
  },
  {
    id: 'cmd-rm-fR',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","-fR",' },
    reasonCode: 'cmd-rm-fR',
  },
  {
    id: 'cmd-rm-long-recursive',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["rm","--recursive",' },
    reasonCode: 'cmd-rm-long-recursive',
  },
  {
    id: 'path-etc-passwd',
    action: ActionId.CommandExec,
    matcher: { type: 'wildcard', pattern: '*"/etc/passwd"*' },
    reasonCode: 'path-etc-passwd',
  },
  {
    id: 'path-etc-sudoers',
    action: ActionId.CommandExec,
    matcher: { type: 'wildcard', pattern: '*"/etc/sudoers"*' },
    reasonCode: 'path-etc-sudoers',
  },
  {
    id: 'cmd-dd-device-output',
    action: ActionId.CommandExec,
    matcher: { type: 'wildcard', pattern: '["dd",*"of=/dev/*]' },
    reasonCode: 'cmd-dd-device-output',
  },
  {
    id: 'cmd-firewall-iptables',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["iptables",' },
    reasonCode: 'cmd-firewall-iptables',
  },
  {
    id: 'cmd-firewall-ip6tables',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["ip6tables",' },
    reasonCode: 'cmd-firewall-ip6tables',
  },
  {
    id: 'cmd-firewall-nft',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["nft",' },
    reasonCode: 'cmd-firewall-nft',
  },
  {
    id: 'cmd-firewall-ufw',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["ufw",' },
    reasonCode: 'cmd-firewall-ufw',
  },
  {
    id: 'cmd-firewall-cmd',
    action: ActionId.CommandExec,
    matcher: { type: 'prefix', pattern: '["firewall-cmd",' },
    reasonCode: 'cmd-firewall-cmd',
  },
]);
