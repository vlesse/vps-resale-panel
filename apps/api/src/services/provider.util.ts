/** Normalize inventory provider label for driver routing. */
export function normalizeProvider(provider?: string | null): 'proxmox' | 'ssh' {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'proxmox' || p === 'pve' || p === 'px' || p.startsWith('proxmox')) {
    return 'proxmox';
  }
  // cloudcone / aliyun / ssh / manual / anything else: guest SSH path
  return 'ssh';
}

/** Customer-facing control plane label (no upstream brand names). */
export function controlPlaneLabel(provider?: string | null): string {
  return normalizeProvider(provider) === 'proxmox' ? 'hypervisor' : 'agent';
}
