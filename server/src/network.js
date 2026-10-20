import os from 'node:os';

// Container and VM bridges are never reachable for people on the same Wi-Fi.
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|podman|cni|flannel|vmnet|vboxnet|lo)/;

/** IPv4 addresses other devices on the local network can reach this machine on. */
export function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL_IFACE.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}
