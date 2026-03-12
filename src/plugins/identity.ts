export type PluginSourceKind = 'marketplace' | 'plugin';

export function buildPluginId(
  name: string,
  sourceName: string,
  sourceKind: PluginSourceKind
): string {
  return sourceKind === 'marketplace' ? `${name}@${sourceName}` : name;
}

export function buildComponentId(pluginId: string, bareId: string): string {
  return `${pluginId}:${bareId}`;
}

export function splitComponentId(componentId: string): { pluginId: string; bareId: string } | null {
  const sep = componentId.lastIndexOf(':');
  if (sep <= 0 || sep === componentId.length - 1) return null;
  return {
    pluginId: componentId.slice(0, sep),
    bareId: componentId.slice(sep + 1),
  };
}

export function getBarePluginName(pluginId: string, sourceKind: PluginSourceKind): string {
  if (sourceKind !== 'marketplace') return pluginId;
  const at = pluginId.lastIndexOf('@');
  return at > 0 ? pluginId.slice(0, at) : pluginId;
}
