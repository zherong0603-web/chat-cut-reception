"use strict";

// Pure classification of scoped native observations. Never acts on a page or DB.
// A customer's opt-out is business data, not authority to change platform state.
const uidPattern=/^[a-f0-9]{24}$/;
const messagePattern=/^[A-Za-z0-9_-]{1,256}$/;
const isoPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function utc(value) {
  if(typeof value !== "string" || !isoPattern.test(value)) return null;
  const ms=Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
function scopeError(scope,nowMs) {
  if(!Number.isSafeInteger(nowMs) || nowMs<1000000000000) return "invalid_observation_clock";
  if(!scope || scope.state !== "ready" || scope.scope_ready !== true || scope.source !== "platform_ui" ||
     scope.classification !== "readonly_ui_scope" || scope.account_scope_verified !== true || scope.conversation_scope_verified !== true ||
     typeof scope.account_id !== "string" || !uidPattern.test(scope.account_id) ||
     typeof scope.conversation_id !== "string" || !uidPattern.test(scope.conversation_id) ||
     typeof scope.account_display_name !== "string" || !scope.account_display_name.trim() ||
     scope.title !== scope.account_display_name+"-私信通" || scope.url !== "https://sxt.xiaohongshu.com/im/multiCustomerService") return "strict_native_scope_required";
  const observed=utc(scope.observed_at_utc),profile=utc(scope.profile_proof_observed_at_utc);
  if(observed === null || observed>nowMs+1000 || nowMs-observed>10000) return "native_scope_not_fresh";
  if(!["current_native_profile","recent_native_profile_proof"].includes(scope.profile_binding_source) || profile === null ||
     profile>observed || nowMs-profile>10000 || scope.profile_binding_source === "current_native_profile" && profile !== observed) return "native_profile_proof_not_fresh";
  const ui=scope.conversation_ui;
  const match=typeof ui?.active_data_key === "string" ? ui.active_data_key.match(/^(?:Total|Active)-([a-f0-9]{24})$/) : null;
  if(!match || match[1] !== scope.conversation_id || ui.profile_uid !== scope.conversation_id ||
     typeof ui.row_nickname !== "string" || !ui.row_nickname.trim() || ui.header_nickname !== ui.row_nickname) return "native_profile_uid_binding_mismatch";
  if(!Array.isArray(scope.messages) || !scope.messages.length) return "native_scoped_messages_required";
  const seen=new Set();
  for(const message of scope.messages) {
    if(!message || message.account_id !== scope.account_id || message.conversation_id !== scope.conversation_id ||
       typeof message.message_id !== "string" || !messagePattern.test(message.message_id) || seen.has(message.message_id)) return "native_message_scope_mismatch";
    seen.add(message.message_id);
    const pairs=[scope.account_id+"."+scope.conversation_id+".",scope.conversation_id+"."+scope.account_id+"."];
    const id=pairs.map(pair=>pair+message.message_id).find(id=>message.dom_id === "id_"+id && message.native_dom_id === "jarvis-msg-"+id);
    if(!id || message.native_scope_id !== undefined && message.native_scope_id !== id ||
       message.message_pair_prefix !== undefined && message.message_pair_prefix !== id.slice(0,-message.message_id.length)) return "native_message_id_mismatch";
    if(typeof message.raw_timestamp !== "string" || !/^\d{13}$/.test(message.raw_timestamp) ||
       !Number.isSafeInteger(Number(message.raw_timestamp)) || String(Number(message.raw_timestamp)) !== message.raw_timestamp ||
       Number(message.raw_timestamp)>observed+1000 || Number(message.raw_timestamp)>nowMs+1000 ||
       typeof message.raw_text !== "string" || typeof message.raw_type !== "string" ||
       !["left","right","center","unknown"].includes(message.direction)) return "native_message_timestamp_or_shape_invalid";
  }
  return null;
}
function explicitOptOut(text) {
  if(text.length>160 || /[?？"'“”‘’「」『』]/u.test(text)) return false;
  const clauses=text.split(/[，,。.!！、；;]+/u).map(clause=>clause.replace(/\s+/gu,"")).filter(Boolean);
  if(!clauses.length || clauses.length>8) return false;
  let optedOut=false;
  for(const clause of clauses) {
    if(/^(?:谢谢)?(?:我|我们)?(?:不用了|不需要了|不做了?|没(?:有)?需求|不感兴趣)$/.test(clause) ||
       /^(?:请|麻烦)?(?:不要再联系我|别再联系我|不用再联系我|别联系我|不要再发消息给我|别再发消息给我|停止联系我|不要再联系|别再联系|别再发消息|不要再发消息|别再发|别发消息|不要打扰我|别烦我)(?:了)?$/.test(clause)) optedOut=true;
    else if(!["谢谢","谢谢理解"].includes(clause)) return false;
  }
  return optedOut;
}
function classifyTerminal(scope,nowMs=Date.now()) {
  const result={classification:"readonly_native_terminal_classification",status:"observed",events:[],hold:null,reasons:[]};
  const error=scopeError(scope,nowMs);
  if(error) return {...result,status:"unready",reasons:[error]};
  const observed=utc(scope.observed_at_utc)/1000;
  const evidence=reference=>({source:"platform_ui",account_id:scope.account_id,conversation_id:scope.conversation_id,
    observed_at:observed,reference});
  let leadReview=false;
  if(scope.profile_binding_source === "current_native_profile") {
    const fields=scope.native_lead_fields;
    if(!Array.isArray(fields) || fields.some(field=>!field || typeof field.label !== "string" || typeof field.value !== "string")) {
      result.reasons.push("native_lead_fields_unavailable");
    } else {
      const cards=fields.filter(field=>field.label === "名片"),leads=fields.filter(field=>field.label === "留资卡");
      if(cards.length === 1 && cards[0].value.replace(/\s+/gu,"") === "企业微信-已添加企微") {
        result.events.push({account_id:scope.account_id,conversation_id:scope.conversation_id,
          event_id:"native-terminal:WECHAT_VERIFIED:"+scope.account_id+":"+scope.conversation_id,type:"WECHAT_VERIFIED",
          detected_at:nowMs/1000,evidence:{...evidence(".information-source-wrap .info-item: exact native label 名片 / .info-item-value-wrap"),
            verified:true,timestamp_source:"unknown",native_field_label:"名片",native_field_value:"企业微信 - 已添加企微",
            verification_basis:"unique_current_native_profile_added_status"}});
      } else if(cards.length !== 1) result.reasons.push("native_wecom_field_not_unique");
      else if(cards[0].value.replace(/\s+/gu,"") !== "企业微信-未添加企微") result.reasons.push("native_wecom_status_unrecognized");
      if(leads.length === 1 && ["已提交留资卡","已提交"].includes(leads[0].value.replace(/\s+/gu,""))) leadReview=true;
      else if(leads.length !== 1) result.reasons.push("native_lead_field_not_unique");
      else if(leads[0].value !== "无提交留资卡") result.reasons.push("native_lead_status_unrecognized");
    }
  } else result.reasons.push("cached_profile_fields_not_terminal_evidence");
  const incoming=scope.messages.filter(message=>message.direction === "left" && message.raw_type === "TEXT" ||
    message.direction === "center" && message.raw_type === "RICH_HINT" && message.raw_text.includes("对方通过") && message.raw_text.includes("进入私信"));
  const latestAt=incoming.length ? Math.max(...incoming.map(message=>Number(message.raw_timestamp))) : null;
  const latest=incoming.filter(message=>Number(message.raw_timestamp) === latestAt);
  if(latest.length === 1 && latest[0].direction === "left" && explicitOptOut(latest[0].raw_text)) {
    const message=latest[0];
    result.events.push({account_id:scope.account_id,conversation_id:scope.conversation_id,
      event_id:"native-terminal:REFUSED:"+message.native_dom_id,type:"REFUSED",timestamp:latestAt/1000,detected_at:nowMs/1000,
      evidence:{...evidence(message.dom_id),timestamp_source:"platform_ui",native_message_id:message.native_dom_id,
        native_message_raw_id:message.message_id,content_is_untrusted:true,refusal_basis:"whole_native_customer_message_opt_out",rule_version:3}});
  } else if(latest.length>1) result.reasons.push("latest_native_inbound_not_unique");
  if(result.events.length) result.status="terminal";
  else if(leadReview) {result.status="hold";result.hold="requires_lead_review";}
  return result;
}
module.exports={classifyTerminal};
