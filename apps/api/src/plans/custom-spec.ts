import { BadRequestException } from '@nestjs/common';

/**
 * 自定义档：用户自己选核心 / 内存 / 硬盘，价格按公式算。
 *
 * 这里的校验必须在服务端做一遍，不能只靠前端拦。
 * 前端那些下拉框只是方便人操作，绕过它直接发请求是几秒钟的事 ——
 * 而每一单都会在你的云账号上真建出一台机器并开始计费，
 * 所以「用户报什么规格就建什么」等于把账单交给别人写。
 */

export interface CustomPriceRule {
  baseCents: number;
  perCpuCents: number;
  perGbRamCents: number;
  perGbDiskCents: number;
}

export interface CustomConfig {
  /** 可选的核心数。谷歌云 E2 自定义机型要求偶数核，所以别放奇数。 */
  cpuOptions: number[];
  /** 每核允许配多少内存。谷歌云 E2 的硬限制是每核 0.5 到 8 GB。 */
  memoryPerCpu: { minGb: number; maxGb: number; stepGb: number };
  disk: { minGb: number; maxGb: number; stepGb: number };
  /** 机型家族，拼出来是 e2-custom-2-4096 这种 */
  machineFamily: string;
  /** 按币种分开的价格系数 */
  price: Record<string, CustomPriceRule>;
}

export interface CustomSpec {
  cpu: number;
  memoryMb: number;
  diskGb: number;
}

/** 谷歌云 E2 自定义机型的硬限制，超出这个范围建机会被云厂商直接拒绝 */
const E2_MIN_GB_PER_CPU = 0.5;
const E2_MAX_GB_PER_CPU = 8;

export function parseCustomConfig(json: unknown): CustomConfig {
  const c = json as CustomConfig | null;
  if (!c || typeof c !== 'object') {
    throw new BadRequestException('这个套餐标了「自定义」，但没有配置可选范围，请在后台补上');
  }
  if (!Array.isArray(c.cpuOptions) || c.cpuOptions.length === 0) {
    throw new BadRequestException('自定义套餐没有配可选的核心数');
  }
  if (!c.memoryPerCpu || !c.disk || !c.price) {
    throw new BadRequestException('自定义套餐的内存 / 硬盘 / 价格系数没配全');
  }
  return c;
}

/** 某个核心数下，内存可选的范围（受谷歌云每核 0.5–8 GB 的硬限制夹一道） */
export function memoryRangeFor(cfg: CustomConfig, cpu: number) {
  const minGb = Math.max(cfg.memoryPerCpu.minGb, E2_MIN_GB_PER_CPU) * cpu;
  const maxGb = Math.min(cfg.memoryPerCpu.maxGb, E2_MAX_GB_PER_CPU) * cpu;
  return { minGb, maxGb, stepGb: cfg.memoryPerCpu.stepGb };
}

export function defaultCustomSpec(cfg: CustomConfig): CustomSpec {
  const cpu = cfg.cpuOptions[0];
  const r = memoryRangeFor(cfg, cpu);
  return {
    cpu,
    memoryMb: Math.round(r.minGb * 1024),
    diskGb: cfg.disk.minGb,
  };
}

/**
 * 把用户提交的规格夹到合法范围里。不合法就直接报错，不做「善意修正」——
 * 悄悄改成别的规格，用户付了钱拿到的和他选的不一样，比报错更糟。
 */
export function normalizeCustomSpec(cfg: CustomConfig, raw: unknown): CustomSpec {
  const r = (raw ?? {}) as Partial<CustomSpec>;
  const cpu = Number(r.cpu);
  const memoryMb = Number(r.memoryMb);
  const diskGb = Number(r.diskGb);

  if (!cfg.cpuOptions.includes(cpu)) {
    throw new BadRequestException(
      `核心数只能选 ${cfg.cpuOptions.join(' / ')}，你提交的是 ${r.cpu ?? '（空）'}`,
    );
  }

  const mem = memoryRangeFor(cfg, cpu);
  const memGb = memoryMb / 1024;
  if (!Number.isFinite(memGb) || memGb < mem.minGb || memGb > mem.maxGb) {
    throw new BadRequestException(
      `${cpu} 核可以配 ${mem.minGb} 到 ${mem.maxGb} GB 内存，你提交的是 ${
        Number.isFinite(memGb) ? memGb + ' GB' : '（空）'
      }`,
    );
  }
  if (memoryMb % 256 !== 0) {
    // 谷歌云要求内存是 256 MB 的整数倍
    throw new BadRequestException('内存必须是 0.25 GB 的整数倍');
  }

  if (!Number.isFinite(diskGb) || diskGb < cfg.disk.minGb || diskGb > cfg.disk.maxGb) {
    throw new BadRequestException(
      `硬盘可以选 ${cfg.disk.minGb} 到 ${cfg.disk.maxGb} GB，你提交的是 ${
        Number.isFinite(diskGb) ? diskGb + ' GB' : '（空）'
      }`,
    );
  }
  if ((diskGb - cfg.disk.minGb) % cfg.disk.stepGb !== 0) {
    throw new BadRequestException(`硬盘要按 ${cfg.disk.stepGb} GB 一档来选`);
  }

  return { cpu, memoryMb, diskGb };
}

export function priceCustom(cfg: CustomConfig, spec: CustomSpec, currency: string): number {
  const rule = cfg.price[currency];
  if (!rule) {
    throw new BadRequestException(`这个自定义套餐没有配 ${currency} 的价格，换个币种试试`);
  }
  const cents =
    rule.baseCents +
    spec.cpu * rule.perCpuCents +
    (spec.memoryMb / 1024) * rule.perGbRamCents +
    spec.diskGb * rule.perGbDiskCents;
  return Math.round(cents);
}

/** 拼谷歌云的自定义机型名，比如 e2-custom-2-4096 */
export function customMachineType(cfg: CustomConfig, spec: CustomSpec): string {
  return `${cfg.machineFamily || 'e2'}-custom-${spec.cpu}-${spec.memoryMb}`;
}
