'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Notice, PanelBar, Unit } from '@/components/ui';

interface Channel {
  id: string;
  code: string;
  name: string;
  driver: string;
  wayCode: string | null;
  settleCurrency: string | null;
  payCurrency: string | null;
  payRate: number | null;
  payCurrencyToGateway: boolean;
  gatewayUrl: string | null;
  rate: number | null;
  usdToCnyRate: number | null;
  isEnabled: boolean;
  sortOrder: number;
  descText: string | null;
  credentialSummary: Record<string, string>;
}

interface CredentialField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  hint: string;
}

interface DriverSpec {
  driver: string;
  label: string;
  hint: string;
  needsWayCode: boolean;
  wayCodeHint?: string;
  needsRate?: boolean;
  credentialFields: CredentialField[];
}

/** 加通道时的默认名字，省得每次都自己想 */
const PRESET_NAME: Record<string, string> = {
  epay: '支付宝 / 微信',
  usdt_trc20: 'USDT（TRC20）',
  jeepay: '扫码支付',
  balance: '账户余额',
  manual: '线下转账',
};

export default function PayChannels() {
  const [rows, setRows] = useState<Channel[] | null>(null);
  const [specs, setSpecs] = useState<DriverSpec[]>([]);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'crit' | 'warn'; text: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [ef, setEf] = useState<Record<string, string>>({});
  /** 编辑时明确要清空的凭据字段。「留空 = 不改」，所以清空得单独说。 */
  const [clearing, setClearing] = useState<string[]>([]);

  const load = () =>
    api.get<Channel[]>('/api/admin/pay-channels').then(setRows).catch(() => undefined);

  useEffect(() => {
    void load();
    api
      .publicGet<DriverSpec[]>('/api/payments/driver-specs')
      .then(setSpecs)
      .catch(() => undefined);
  }, []);

  const spec = specs.find((s) => s.driver === adding);

  const pick = (driver: string) => {
    setAdding(adding === driver ? null : driver);
    setF({ code: driver, name: PRESET_NAME[driver] ?? '' });
  };

  const create = async () => {
    if (!spec) return;
    setFlash(null);
    const credentials: Record<string, string> = {};
    for (const cf of spec.credentialFields) {
      if (f[cf.key]) credentials[cf.key] = f[cf.key].trim();
    }
    try {
      const r = await api.post<any>('/api/admin/pay-channels', {
        code: (f.code || spec.driver).trim(),
        name: (f.name || spec.label).trim(),
        driver: spec.driver,
        wayCode: spec.needsWayCode ? f.wayCode?.trim() : undefined,
        gatewayUrl: credentials.gatewayUrl,
        settleCurrency: f.settleCurrency?.trim() || undefined,
        payCurrency: f.payCurrency?.trim() || undefined,
        payRate: f.payRate ? Number(f.payRate) : undefined,
        usdToCnyRate: f.usdToCnyRate ? Number(f.usdToCnyRate) : undefined,
        descText: f.descText,
        credentials,
      });
      setFlash({
        tone: r.check?.ok === false ? 'crit' : 'ok',
        text:
          r.check?.ok === false
            ? `已添加，但测试没通过：${r.check.message}`
            : `已添加并测试通过。${r.check?.message ?? ''}`,
      });
      setAdding(null);
      setF({});
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  const set = (k: string) => ({
    value: f[k] ?? '',
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }),
  });

  const eset = (k: string) => ({
    value: ef[k] ?? '',
    onChange: (e: { target: { value: string } }) => setEf({ ...ef, [k]: e.target.value }),
  });

  const openEdit = (c: Channel) => {
    if (editing === c.id) {
      setEditing(null);
      return;
    }
    setEditing(c.id);
    setClearing([]);
    setEf({
      name: c.name,
      wayCode: c.wayCode ?? '',
      payCurrency: c.payCurrency ?? '',
      payRate: c.payRate == null ? '' : String(c.payRate),
      payCurrencyToGateway: c.payCurrencyToGateway ? '1' : '',
      sortOrder: String(c.sortOrder ?? 0),
      descText: c.descText ?? '',
    });
  };

  /**
   * 保存改动。
   *
   * 空字符串要原样发过去，不能 `|| undefined` —— 那样「把手工汇率清掉、
   * 改回用实时汇率」这个操作永远做不到：字段被当成没填，后端就不会去动它。
   */
  const saveEdit = async (c: Channel) => {
    setFlash(null);
    try {
      // 凭据：只把真填了的送过去。后端是「填了才改，留空不改」，
      // 所以这里不能把空值也塞进去 —— 那会让人以为清空了，实际没有。
      const credentials: Record<string, string> = {};
      const spec = specs.find((x) => x.driver === c.driver);
      for (const cf of spec?.credentialFields ?? []) {
        const v = ef[`cred_${cf.key}`];
        if (v && v.trim()) credentials[cf.key] = v.trim();
      }
      await api.patch(`/api/admin/pay-channels/${c.id}`, {
        name: ef.name?.trim() || c.name,
        ...(Object.keys(credentials).length ? { credentials } : {}),
        ...(clearing.length ? { clearCredentials: clearing } : {}),
        wayCode: ef.wayCode?.trim() || null,
        payCurrency: ef.payCurrency?.trim() || null,
        payRate: ef.payRate?.trim() ? Number(ef.payRate) : null,
        payCurrencyToGateway: ef.payCurrencyToGateway === '1',
        sortOrder: Number(ef.sortOrder) || 0,
        descText: ef.descText?.trim() || null,
      });
      setEditing(null);
      setFlash({ tone: 'ok', text: '已保存' });
      await load();
    } catch (e: any) {
      setFlash({ tone: 'crit', text: e.message });
    }
  };

  return (
    <>
      <Unit>
        <PanelBar title="支付通道" meta="用户结算页和充值页看到的付款方式">
          <div className="spacer" />
          <div className="btnrow">
            {specs.map((s) => (
              <button
                key={s.driver}
                className={`btn btn--sm ${adding === s.driver ? 'btn--key' : ''}`}
                onClick={() => pick(s.driver)}
              >
                + {s.label}
              </button>
            ))}
          </div>
        </PanelBar>
        <div className="panelbody">
          <Notice tone="info">
            商户密钥加密存储，页面上只显示脱敏摘要。回调地址会自动用 .env 里的
            PUBLIC_BASE_URL 拼出来 —— 那个值填错的话，用户付了钱订单不会变成已支付。
          </Notice>
          {flash && (
            <div style={{ marginTop: 14 }}>
              <Notice tone={flash.tone === 'warn' ? 'warn' : flash.tone}>{flash.text}</Notice>
            </div>
          )}
        </div>
      </Unit>

      {spec && (
        <Unit>
          <PanelBar title={`添加${spec.label}`} meta={spec.hint} />
          <div className="panelbody">
            <div className="grid2">
              <div className="field">
                <label className="label">通道代码（英文，唯一）</label>
                <input className="input" spellCheck={false} {...set('code')} />
                <span className="hint">内部用，用户看不到。同一种驱动配多个通道时靠它区分。</span>
              </div>
              <div className="field">
                <label className="label">显示名（用户看得到）</label>
                <input className="input" {...set('name')} />
              </div>

              {spec.credentialFields.map((cf) => (
                <div className="field" key={cf.key}>
                  <label className="label">
                    {cf.label}
                    {!cf.required && <span className="silk">（选填）</span>}
                  </label>
                  {cf.type === 'textarea' ? (
                    <textarea
                      className="textarea"
                      style={{ minHeight: 90, fontFamily: 'var(--f-mono)', fontSize: 12 }}
                      spellCheck={false}
                      {...set(cf.key)}
                    />
                  ) : (
                    <input
                      className="input"
                      type={cf.type === 'password' ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      {...set(cf.key)}
                    />
                  )}
                  {cf.hint && <span className="hint">{cf.hint}</span>}
                </div>
              ))}

              {spec.needsWayCode && (
                <div className="field">
                  <label className="label">支付方式</label>
                  <input className="input" spellCheck={false} {...set('wayCode')} />
                  <span className="hint">{spec.wayCodeHint}</span>
                </div>
              )}

              {/* 余额通道不出网，没有「顾客实付币种」这回事 */}
              {spec.driver !== 'balance' && (
                <>
                  <div className="field">
                    <label className="label">
                      顾客实付币种<span className="silk">（选填）</span>
                    </label>
                    <input
                      className="input"
                      spellCheck={false}
                      placeholder="KHR"
                      maxLength={3}
                      {...set('payCurrency')}
                    />
                    <span className="hint">
                      收款码收的不是人民币时填这里，比如柬埔寨的 ABA 填 KHR。
                      填了之后付款页会按当日汇率算出「本次需要输入多少瑞尔」并显著提示 ——
                      静态收款码里不带金额，顾客要自己敲，不写清楚就会收错钱。
                      留空表示就按面板计价币种付。
                    </span>
                  </div>
                  <div className="field">
                    <label className="label">
                      手工汇率<span className="silk">（选填）</span>
                    </label>
                    <input
                      className="input"
                      type="number"
                      step="0.0001"
                      placeholder="留空 = 用当日实时汇率"
                      {...set('payRate')}
                    />
                    <span className="hint">
                      1 单位计价币 = 多少上面那个币种。跟收单行谈的是固定汇率时填这里，
                      填了就不再查实时汇率。
                    </span>
                  </div>
                </>
              )}

              {spec.needsRate && (
                <div className="field">
                  <label className="label">汇率（1 USDT = 多少人民币）</label>
                  <input className="input" type="number" step="0.01" placeholder="7.25" {...set('usdToCnyRate')} />
                  <span className="hint">
                    人民币计价的订单靠它算该收多少币。汇率变了记得回来改，
                    这个值只影响新发起的付款，已经在等待的不会变。
                  </span>
                </div>
              )}
            </div>

            <div className="field">
              <label className="label">给用户的说明（可空）</label>
              <textarea
                className="textarea"
                style={{ minHeight: 80 }}
                placeholder={
                  spec.driver === 'manual'
                    ? '收款账号、户名、转账后如何联系客服'
                    : '会显示在支付方式下面的一行小字'
                }
                {...set('descText')}
              />
            </div>

            <div className="btnrow">
              <button className="btn btn--key" onClick={create}>添加并测试</button>
              <button className="btn" onClick={() => setAdding(null)}>取消</button>
            </div>
          </div>
        </Unit>
      )}

      {rows?.length === 0 && (
        <Unit>
          <div className="panelbody">
            <Notice tone="warn">
              还没有配置支付方式。没有支付方式用户下了单也付不了钱。
              最省事的是先加一个「线下转账」，把收款账号写在说明里，
              收到款后到订单页点「标记已付」。
            </Notice>
          </div>
        </Unit>
      )}

      {rows?.map((c) => (
        <Unit key={c.id}>
          <div className="panelbody">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="title" style={{ fontSize: 16 }}>{c.name}</div>
                <div className="silk" style={{ fontSize: 10, marginTop: 4 }}>
                  {c.code} · {c.driver}
                  {c.wayCode ? ` · ${c.wayCode}` : ''}
                  {c.settleCurrency ? ` · 以 ${c.settleCurrency} 结算` : ''}
                  {c.payCurrency ? ` · 顾客实付 ${c.payCurrency}` : ''}
                  {c.payRate ? ` · 固定汇率 ${c.payRate}` : ''}
                  {c.payCurrencyToGateway ? ' · 折算后上报网关' : ''}
                  {c.usdToCnyRate ? ` · 1 USDT ≈ ${c.usdToCnyRate} 元` : ''}
                </div>
              </div>
              <Badge tone={c.isEnabled ? 'ok' : 'mute'}>{c.isEnabled ? '已启用' : '已停用'}</Badge>
            </div>

            <div className="well" style={{ marginTop: 14 }}>
              <div className="readout">
                {Object.entries(c.credentialSummary).map(([k, v]) => (
                  <div key={k}>
                    <div className="ro-k">{k}</div>
                    <div className="data" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {editing === c.id && (
              <div className="well" style={{ marginTop: 14 }}>
                <div className="grid2">
                  <div className="field">
                    <label className="label">显示名</label>
                    <input className="input" {...eset('name')} />
                  </div>
                  <div className="field">
                    <label className="label">排序</label>
                    <input className="input" type="number" {...eset('sortOrder')} />
                    <span className="hint">
                      数字小的排前面，也就是付款页默认选中的那个。
                    </span>
                  </div>
                  {c.driver !== 'balance' && c.driver !== 'manual' && (
                    <div className="field">
                      <label className="label">支付方式（wayCode）</label>
                      <input className="input" spellCheck={false} {...eset('wayCode')} />
                    </div>
                  )}
                  {c.driver !== 'balance' && (
                    <>
                      <div className="field">
                        <label className="label">顾客实付币种</label>
                        <input
                          className="input"
                          spellCheck={false}
                          placeholder="KHR"
                          maxLength={3}
                          {...eset('payCurrency')}
                        />
                        <span className="hint">
                          收款码收的不是人民币时填，比如 ABA 填 KHR。付款页会按当日汇率
                          算出「本次需要输入多少瑞尔」并显著提示。留空 = 不折算。
                        </span>
                      </div>
                      <div className="field">
                        <label className="label">手工汇率</label>
                        <input
                          className="input"
                          type="number"
                          step="0.0001"
                          placeholder="留空 = 用当日实时汇率"
                          {...eset('payRate')}
                        />
                      </div>
                      <div className="field">
                        <label className="label">折算后的金额也报给网关</label>
                        <select
                          className="input"
                          value={ef.payCurrencyToGateway ?? ''}
                          onChange={(e) =>
                            setEf({ ...ef, payCurrencyToGateway: e.target.value })
                          }
                        >
                          <option value="">否 —— 只改给顾客看的数字</option>
                          <option value="1">是 —— 网关也按这个币种和金额下单</option>
                        </select>
                        <span className="hint">
                          网关如果是靠「等一笔金额对得上的钱」来销账的，就必须选「是」，
                          否则网关记着 1.00 元、顾客付的是 603 瑞尔，订单会一直停在「支付中」。
                          选了之后网关要是不认这个币种，下单会当场报错，改回「否」即可。
                        </span>
                      </div>
                    </>
                  )}
                </div>
                {(specs.find((x) => x.driver === c.driver)?.credentialFields ?? []).length > 0 && (
                  <>
                    <div className="label" style={{ marginTop: 4 }}>凭据</div>
                    <p className="hint" style={{ marginTop: 4 }}>
                      <strong>留空 = 不改。</strong>只填你要换的那一项，其余的不会被动。
                      要彻底清掉某一项，勾上它后面的「清空」。
                    </p>
                    <div className="grid2" style={{ marginTop: 8 }}>
                      {(specs.find((x) => x.driver === c.driver)?.credentialFields ?? []).map((cf) => (
                        <div className="field" key={cf.key}>
                          <label className="label">
                            {cf.label}
                            <span className="silk">
                              （当前：{c.credentialSummary[cf.label] ?? c.credentialSummary[cf.key] ?? '—'}）
                            </span>
                          </label>
                          {cf.type === 'textarea' ? (
                            <textarea
                              className="textarea"
                              style={{ minHeight: 80, fontFamily: 'var(--f-mono)', fontSize: 12 }}
                              spellCheck={false}
                              disabled={clearing.includes(cf.key)}
                              {...eset(`cred_${cf.key}`)}
                            />
                          ) : (
                            <input
                              className="input"
                              type={cf.type === 'password' ? 'password' : 'text'}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="留空 = 不改"
                              disabled={clearing.includes(cf.key)}
                              {...eset(`cred_${cf.key}`)}
                            />
                          )}
                          {!cf.required && (
                            <label className="hint" style={{ marginTop: 6, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={clearing.includes(cf.key)}
                                onChange={(e) =>
                                  setClearing(
                                    e.target.checked
                                      ? [...clearing, cf.key]
                                      : clearing.filter((k) => k !== cf.key),
                                  )
                                }
                                style={{ marginRight: 6 }}
                              />
                              清空这一项
                            </label>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                <div className="field">
                  <label className="label">给用户的说明</label>
                  <textarea className="textarea" style={{ minHeight: 80 }} {...eset('descText')} />
                  {c.driver === 'manual' && (
                    <span className="hint">
                      线下转账全靠这段话。把真实的收款账号、户名、转账后怎么联系写进去 ——
                      用户看到的就是这一段，写着「xxx」的话他不知道该往哪转。
                    </span>
                  )}
                </div>
                <div className="btnrow">
                  <button className="btn btn--key btn--sm" onClick={() => saveEdit(c)}>
                    保存
                  </button>
                  <button className="btn btn--sm" onClick={() => setEditing(null)}>取消</button>
                </div>
              </div>
            )}

            <div className="btnrow" style={{ marginTop: 14 }}>
              <button className="btn btn--sm" onClick={() => openEdit(c)}>
                {editing === c.id ? '收起' : '编辑'}
              </button>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  setFlash({ tone: 'warn', text: '正在测试…' });
                  try {
                    const r = await api.post<any>(`/api/admin/pay-channels/${c.id}/verify`);
                    const extra = r.detail
                      ? '　' + Object.entries(r.detail).map(([k, v]) => `${k}：${v}`).join('，')
                      : '';
                    setFlash({ tone: r.ok ? 'ok' : 'crit', text: r.message + extra });
                  } catch (e: any) {
                    setFlash({ tone: 'crit', text: e.message });
                  }
                }}
              >
                测试
              </button>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  await api.patch(`/api/admin/pay-channels/${c.id}`, { isEnabled: !c.isEnabled });
                  await load();
                }}
              >
                {c.isEnabled ? '停用' : '启用'}
              </button>
              <button
                className="btn btn--sm btn--danger"
                onClick={async () => {
                  try {
                    const r = await api.del<any>(`/api/admin/pay-channels/${c.id}`);
                    setFlash({ tone: 'ok', text: r.message ?? '已删除' });
                  } catch (e: any) {
                    setFlash({ tone: 'crit', text: e.message });
                  }
                  await load();
                }}
              >
                删除
              </button>
            </div>
          </div>
        </Unit>
      ))}
    </>
  );
}
