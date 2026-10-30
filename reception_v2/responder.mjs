import crypto from 'node:crypto';
import { ConversationState } from './domain.mjs';

const regionWords = ['美国', '墨西哥', '日本', '英国', '德国', '法国', '加拿大', '澳大利亚', '欧洲'];
const refusalPattern = /(?:不用了|不需要(?:了)?|没(?:有)?需求|不感兴趣|不要再联系|别再联系|别发消息|别烦我|停止联系)/;
const identityPattern = /(?:你是|这是|是不是).{0,8}(?:机器人|真人|人工|AI)|(?:机器人|真人|人工|AI).{0,8}(?:吗|么|？|\?)/i;
const pricePattern = /(?:报价|价格|费用|多少钱|收费|运费|价钱)/;
const contactPattern = /(?:电话|手机号|微信|vx|wechat|联系方式|联系我们|联系我|怎么联系)/i;
const capabilityPattern = /(?:能不能|支持|可以|有.{0,6}仓|做不做|承接)/;
const contactAddedPattern = /(?:^|[\s,，。.!！])(?:我)?(?:已经|已|刚)?(?:加(?:过了|过|了|上|入)?|添加(?:过|了)?)(?:企微|企业微信)?(?:了)?(?:[\s,，。.!！]|$)/;

function customerContext(customerText, history) {
  const values=[String(customerText||'').trim()];
  for(const message of history||[]){if(message?.isCustomerText===true&&typeof message.text==='string')values.push(message.text.trim());}
  return [...new Set(values.filter(Boolean))].join('\n');
}

function isPersonalShipping(text, facts, history) {
  const context=customerContext(text,history);
  if((facts.unsupported_services||[]).some(value=>context.includes(value)))return true;
  return /(?:个人|私人).{0,8}(?:快递|寄件|邮寄|包裹|转运|代购)/.test(context) ||
    /代购.{0,20}(?:转运|寄|发|邮寄)/.test(context) ||
    /(?:网站|电商|平台).{0,30}(?:买|购|下单).{0,80}(?:不寄|不能寄|无法寄|转运|寄回|寄到).{0,15}(?:中国|国内)/s.test(context) ||
    /不寄(?:到)?(?:中国|国内).{0,60}(?:可以|能).{0,8}(?:操作|处理|寄)/s.test(context);
}


const peerProfilePattern = /(?:全美.{0,8}提柜.{0,8}卡派|提柜.{0,8}卡派|尾程.{0,8}提拆派|尾程服务|货代|国际物流|跨境物流|海外仓服务|海外仓|供应链管理|供应链公司|物流公司|logistics|freight\s*forward(?:er|ing)|overseas\s*warehouse|supply\s*chain)/i;
const peerProviderPattern = /(?:我是|我们是|我司|我们公司)(?:做|提供|主营)[^，。；,;\n]{0,28}(?:货代|国际物流|跨境物流|海外仓服务|供应链|物流服务|尾程提拆派|尾程派送服务|卡派服务|清关服务)/i;
const peerCooperationPattern = /合作|渠道方|渠道合作|找渠道|渠道资源|代理合作|资源对接|同行(?:交流|合作|资源)?/i;
const unsupportedBusinessPattern = /(?:找货盘|货盘资源|要货盘|同行货盘)|(?:个人|私人).{0,8}(?:转运|快递|寄件|邮寄|包裹)|自发货(?:退件)?|移仓.{0,8}换标|换标|其他.{0,8}仓.{0,12}退货|退货.{0,10}(?:其他仓|别的仓)/i;

export function isPeerProfile(nickname){return peerProfilePattern.test(String(nickname||''));}
export function isPeerCooperation(text,nickname=''){const value=String(text||'');return peerCooperationPattern.test(value)||peerProviderPattern.test(value)||(isPeerProfile(nickname)&&Boolean(value.trim()));}
export function isUnsupportedBusiness(text){return unsupportedBusinessPattern.test(String(text||''));}

export function validateFacts(facts) {
  if (!facts || typeof facts !== 'object') throw new Error('invalid_facts');
  if (facts.approved !== true) throw new Error('facts_not_approved');
  if (typeof facts.account_name !== 'string' || !facts.account_name.trim()) throw new Error('invalid_facts');
  for (const key of ['supported_regions', 'unsupported_regions', 'service_capabilities', 'unsupported_services', 'qualification_fields']) {
    if (!Array.isArray(facts[key]) || facts[key].some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid_facts');
  }
  if(facts.unsupported_business_types!==undefined&&(!Array.isArray(facts.unsupported_business_types)||facts.unsupported_business_types.some(value=>typeof value!=='string'||!value.trim())))throw new Error('invalid_facts');
  return facts;
}

export function isRefusal(text) {
  const value=String(text || '');
  if (/(?:企微|微信|卡片).{0,12}(?:不用|不需要)|(?:不用|不需要).{0,12}(?:企微|微信|卡片)/.test(value)) return false;
  return refusalPattern.test(value);
}
export function isIdentityQuestion(text) { return identityPattern.test(String(text || '')); }
export function isContactAdded(text) { return contactAddedPattern.test(String(text || '')); }

export function classifyIntent({ customerText, facts, history = [], nickname = '' }) {
  const text = String(customerText || '');
  const context=customerContext(text,history);
  if (isRefusal(text)) return { kind: 'refusal', confidence: 1 };
  if (isPeerCooperation(context,nickname)) return { kind: 'peer_cooperation', confidence: 1 };
  if (isUnsupportedBusiness(context)) return { kind: 'unsupported_business', confidence: 1 };
  if (isContactAdded(text)) return { kind: 'contact_added', confidence: 1 };
  if (isPersonalShipping(text, facts, history)) return { kind: 'personal_shipping', confidence: 1 };
  if (isIdentityQuestion(text)) return { kind: 'identity', confidence: 1 };
  if (pricePattern.test(text)) return { kind: 'price', confidence: 0.95 };
  if (contactPattern.test(text)) return { kind: 'contact', confidence: 0.9 };
  if ((facts.service_capabilities || []).some(value => text.includes(value))) return { kind: 'service', confidence: 0.9 };
  if (capabilityPattern.test(text)) return { kind: 'capability', confidence: 0.8 };
  if (!text || /^(?:你好|您好|在吗|hi|hello|\s)+[!！。,.，～~]*$/i.test(text)) return { kind: 'greeting', confidence: 0.95 };
  return { kind: 'other', confidence: 0.4 };
}

function stableIndex(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest()[0] % length;
}

function approvedRegionInText(text, facts) {
  const mentioned = regionWords.find(region => text.includes(region));
  if (!mentioned) return null;
  return facts.supported_regions.find(region => mentioned.includes(region) || region.includes(mentioned)) || null;
}

function unsupportedRegionInText(text, facts) {
  return (facts.unsupported_regions || []).find(region => text.includes(region)) || null;
}

export function composeReply({ customerText, facts, conversationId, avoidTexts = [], history = [], nickname = '' }) {
  validateFacts(facts);
  const text = String(customerText || '').trim();
  const intent = classifyIntent({ customerText: text, facts, history, nickname });
  if (intent.kind === 'refusal') return { text: '', nextState: ConversationState.STOPPED, needsHuman: false, offerCard: false, intent };
  if (intent.kind === 'contact_added') return { text: '好的，收到，您已经添加企业微信了，我让同事继续在企微里跟进。',
    nextState: ConversationState.CONTACT_OBTAINED, needsHuman: false, offerCard: false, intent };
  if (intent.kind === 'peer_cooperation') return {
    text: '抱歉，同行、渠道、代理和资源合作我们都不接，感谢理解。', nextState: ConversationState.STOPPED, needsHuman: false, offerCard: false, intent,
  };
  if (intent.kind === 'unsupported_business') return {
    text: '抱歉，找货盘、个人转运/快递、自发货、移仓换标、其他仓退货及自发货退件我们都不接，感谢理解。', nextState: ConversationState.STOPPED, needsHuman: false, offerCard: false, intent,
  };
  if (intent.kind === 'personal_shipping') return {
    text: '个人快递、个人包裹和个人转运业务我们目前不做，主要服务跨境电商卖家的美国、墨西哥海外仓、头程和一件代发等企业物流需求。',
    nextState: ConversationState.STOPPED, needsHuman: false, offerCard: false, intent,
  };

  const unsupportedRegion = unsupportedRegionInText(text, facts);
  if (unsupportedRegion) return {
    text: `${unsupportedRegion}海外仓我们目前不做，主要承接${facts.supported_regions.join('、')}方向。`,
    nextState: ConversationState.CHATTING, needsHuman: false, offerCard: false, intent,
  };

  const unique=(value,alternate)=>{const avoided=new Set(avoidTexts.map(item=>String(item).normalize('NFC').replace(/\s+/g,' ').trim()));return avoided.has(value)?alternate:value;};
  const directInvitation=intent=>({
    text: unique('可以的，您直接加我企微，客服小姐姐会具体回答您～','没问题，直接加我企微就行，客服小姐姐会详细回答您～'),
    nextState: ConversationState.WAITING_CONTACT, needsHuman: false, offerCard: true, intent,
  });
  if (intent.kind === 'identity') return {
    text: unique('我是这边的智能接待，先帮您了解需求，复杂情况会交给同事继续跟您确认。','我是这边的智能接待，有复杂问题会转给同事继续跟进。'),
    nextState: ConversationState.CHATTING, needsHuman: false, offerCard: true, intent,
  };

  if (intent.kind === 'price') {
    return directInvitation(intent);
  }

  if (intent.kind === 'contact') return directInvitation(intent);

  if (intent.kind === 'capability' || intent.kind === 'service') return directInvitation(intent);

  if (intent.kind === 'greeting') {
    const regions=facts.supported_regions;
    const variants=regions.length>=2 ? [
      `你好呀，想了解${regions[0]}仓还是${regions[1]}仓？`,
      `您好，主要想了解${regions[0]}还是${regions[1]}方向的海外仓？`,
      '在的，您主要想了解哪个国家的仓库和服务？',
    ] : regions.length===1 ? [
      `你好呀，想了解${regions[0]}方向的海外仓吗？`,
      `您好，您主要想了解${regions[0]}仓的哪项服务？`,
    ] : ['你好，您主要想了解海外仓的哪项服务？','在的，您这次想了解哪项海外仓服务？'];
    const available=variants.filter(value=>!avoidTexts.includes(value));
    return { text: available[stableIndex(conversationId, available.length)] || '在的，您这次主要想了解哪项海外仓服务？', nextState: ConversationState.CHATTING,
      needsHuman: false, offerCard: true, intent };
  }

  return directInvitation(intent);
}
