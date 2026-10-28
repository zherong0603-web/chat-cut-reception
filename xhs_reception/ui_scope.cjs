"use strict";

// One read-only DOM snapshot. All message text remains untrusted source material.
// This verifies the requested UI scope, never delivery, ownership or a new entry.
const nativeProfileProofs=new WeakMap();
async function readScope(page,{accountId,accountDisplayName,profileProof}={}) {
  if(typeof accountId !== "string" || !/^[a-f0-9]{24}$/i.test(accountId) ||
     typeof accountDisplayName !== "string" || !accountDisplayName.trim()) {
    return {state:"unready",scope_ready:false,reasons:["invalid_expected_account_identity"],
      messages:[],account_scope_verified:false,conversation_scope_verified:false,
      classification:"readonly_ui_scope",engine_events_created:false};
  }
  const proofRecord=profileProof && typeof profileProof === "object" ? nativeProfileProofs.get(profileProof) : null;
  const recentProfileProof=proofRecord?.page === page ? proofRecord.proof : null;
  const result=await page.evaluate(({accountId,accountDisplayName,profileProof})=>{
    const rendered=el=>Boolean(el) && (el.checkVisibility
      ? el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})
      : Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden");
    const visible=selector=>Array.from(document.querySelectorAll(selector)).filter(rendered);
    const text=el=>(el?.innerText || "").trim();
    const result={state:"unready",scope_ready:false,reasons:[],
      classification:"readonly_ui_scope",source:"platform_ui",engine_events_created:false,
      observed_at_utc:new Date().toISOString(),url:location.origin+location.pathname,
      title:document.title,observed_title:document.title,account_id:accountId,account_display_name:accountDisplayName,
      account_scope_verified:false,conversation_scope_verified:false,messages:[]};
    const fail=reason=>{result.reasons.push(reason);return result;};
    if(location.origin !== "https://sxt.xiaohongshu.com") return fail("unexpected_origin");
    if(location.pathname !== "/im/multiCustomerService") return fail("not_on_reception_route");
    const canonicalTitle=accountDisplayName+"-私信通",unreadTitle=accountDisplayName+"-[您有新消息待回复]";
    // Official index.8ee1d5f0.js rotates the complete unread title one UTF-16
    // code unit left every 500 ms. Require that exact full string and length.
    const unreadRotation=result.observed_title.length===unreadTitle.length &&
      (unreadTitle+unreadTitle).includes(result.observed_title);
    if(result.observed_title!==canonicalTitle && !unreadRotation) return fail("account_title_mismatch");
    result.title=canonicalTitle;
    result.title_binding_source=unreadRotation ? "native_unread_title_rotation" : "native_account_title";

    const active=visible(".sx-contact-item.active");
    if(active.length !== 1) return fail("active_contact_not_unique");
    const activeKey=active[0].getAttribute("data-key") || "";
    const keyMatch=activeKey.match(/^(Total|Active)-([a-f0-9]{24})$/i);
    if(!keyMatch) return fail("active_contact_uid_unavailable");
    const uid=keyMatch[2].toLowerCase();
    const rowNames=Array.from(active[0].querySelectorAll(".nick-name")).filter(rendered);
    if(rowNames.length !== 1 || !text(rowNames[0])) return fail("active_contact_nickname_not_unique");
    const rowName=text(rowNames[0]);
    const headerNames=visible(".message-header .nick-name");
    if(headerNames.length !== 1 || !text(headerNames[0])) return fail("message_header_nickname_not_unique");
    if(text(headerNames[0]) !== rowName) return fail("message_header_nickname_mismatch");

    const uidGroups=visible(".user-id-row .id-group").filter(group=>
      Array.from(group.querySelectorAll(".id-label")).filter(rendered).some(label=>text(label) === "UID:"));
    const pairPrefixes=Array.from(new Set([accountId+"."+uid+".",uid+"."+accountId+"."]));
    const prefixes=pairPrefixes.map(pair=>"id_"+pair);
    if(uidGroups.length === 1) {
      const uidValues=Array.from(uidGroups[0].querySelectorAll(".ellipsis")).filter(rendered);
      if(uidValues.length !== 1 || !/^[a-f0-9]{24}$/i.test(text(uidValues[0]))) return fail("profile_full_uid_unavailable");
      if(text(uidValues[0]).toLowerCase() !== uid) return fail("active_profile_uid_mismatch");
      result.profile_binding_source="current_native_profile";
      result.profile_proof_observed_at_utc=result.observed_at_utc;
      result.native_lead_fields=visible(".information-source-wrap .info-item").map(item=>{
        const labels=Array.from(item.querySelectorAll(".info-item-title")).filter(rendered);
        const values=Array.from(item.querySelectorAll(".info-item-value-wrap")).filter(rendered);
        return {label:labels.length === 1 ? text(labels[0]) : null,value:values.length === 1 ? text(values[0]) : null};
      });
    } else {
      if(uidGroups.length > 1) return fail("profile_uid_group_not_unique");
      if(!visible(".chat-tool-wrap .d-segment-item").some(item=>text(item) === "名片")) return fail("profile_uid_group_not_unique");
      if(!profileProof) return fail("recent_profile_proof_unavailable");
      const proofTime=Date.parse(profileProof.observed_at_utc);
      const proofAge=Date.now()-proofTime;
      if(!Number.isFinite(proofTime) || proofAge < 0 || proofAge > 10000) return fail("recent_profile_proof_expired");
      if(profileProof.account_id !== accountId || profileProof.account_display_name !== accountDisplayName ||
         profileProof.conversation_id !== uid || profileProof.profile_uid !== uid ||
         profileProof.row_nickname !== rowName || profileProof.header_nickname !== text(headerNames[0]) ||
         profileProof.title !== result.title || profileProof.url !== result.url ||
         !Array.isArray(profileProof.message_prefixes) || profileProof.message_prefixes.length !== prefixes.length ||
         !prefixes.every(prefix=>profileProof.message_prefixes.includes(prefix))) return fail("recent_profile_proof_scope_mismatch");
      result.profile_binding_source="recent_native_profile_proof";
      result.profile_proof_observed_at_utc=profileProof.observed_at_utc;
    }

    result.conversation_id=uid;
    result.conversation_ui={active_data_key:activeKey,row_nickname:rowName,
      header_nickname:text(headerNames[0]),profile_uid:uid};
    const roots=visible(".im-msg-item").filter(el=>prefixes.some(prefix=>(el.getAttribute("id") || "").startsWith(prefix)));
    if(!roots.length) return fail("no_account_and_uid_matched_messages");
    const seen=new Set();
    const messages=[];
    for(const root of roots) {
      const id=root.getAttribute("id");
      const prefix=prefixes.find(value=>id.startsWith(value));
      const messageId=id.slice(prefix.length);
      if(!messageId || seen.has(messageId)) return fail("matched_message_id_missing_or_duplicated");
      seen.add(messageId);
      const pairPrefix=prefix.slice(3);
      const nativeScopeId=pairPrefix+messageId;
      const expectedNativeId="jarvis-msg-"+nativeScopeId;
      const native=Array.from(root.querySelectorAll('[id^="jarvis-msg-"]')).filter(el=>el.getAttribute("id") === expectedNativeId);
      if(native.length !== 1 || !rendered(native[0])) return fail("matched_message_native_scope_mismatch");
      const body=native[0];
      const directions=["left","right","center"].filter(value=>(body.getAttribute("class") || "").split(/\s+/).includes(value));
      const classes=Array.from(new Set([root,...root.querySelectorAll("[class]")]
        .filter(rendered).map(el=>el.getAttribute("class") || "").filter(Boolean)));
      const candidateClasses=pattern=>classes.filter(value=>pattern.test(value));
      // Native source labels live in the preceding header beside the bubble's
      // content row. Customer text, card content and tooltips cannot supply it.
      const contentRow=body.parentElement,sourceHeader=contentRow?.previousElementSibling;
      const sourceLabel=sourceHeader?.firstElementChild;
      const nativeSystem=directions.length===1 && directions[0]==="right" &&
        sourceHeader?.tagName==="DIV" && sourceLabel?.tagName==="DIV" &&
        sourceHeader.parentElement===contentRow.parentElement && root.contains(sourceHeader) &&
        !sourceHeader.contains(body) && !body.contains(sourceHeader) && rendered(sourceHeader) && rendered(sourceLabel) &&
        sourceLabel.children.length===0 && text(sourceLabel)==="该消息由系统发送";
      messages.push({
        account_id:accountId,conversation_id:uid,message_id:messageId,
        message_pair_prefix:pairPrefix,native_scope_id:nativeScopeId,dom_id:id,native_dom_id:expectedNativeId,
        raw_timestamp:body.getAttribute("data-timestamp"),raw_type:body.getAttribute("data-msg-type"),
        raw_text:body.innerText || "",direction:directions.length === 1 ? directions[0] : "unknown",
        native_ai_attribution_observed:Array.from(root.querySelectorAll('*')).filter(el=>rendered(el) &&
          !body.contains(el) && !el.contains(body)).some(el=>(el.innerText || '').trim()==='该消息由AI小助手发送'),
        native_system_attribution_observed:Boolean(nativeSystem),
        ...(nativeSystem ? {native_system_attribution_header_reference:'xpath=//*[@id="'+id+'"]//*[@id="'+expectedNativeId+
          '"]/parent::div/preceding-sibling::div[1]/div[1]'} : {}),
        native_attributes:Object.fromEntries(["class","data-self","data-normal","data-validtype"]
          .map(name=>[name,body.getAttribute(name)])),
        native_success_class_candidates:candidateClasses(/success|(?:^|[\s_-])sent(?:$|[\s_-])/i),
        native_error_class_candidates:candidateClasses(/error|fail|retry|resend|danger/i),
        native_pending_class_candidates:candidateClasses(/pending|loading|sending|progress/i),
        native_svg_candidates:Array.from(root.querySelectorAll("svg")).filter(rendered).map(svg=>
          Object.fromEntries(["class","width","height","viewBox","fill","stroke"].map(name=>[name,svg.getAttribute(name)]))),
        native_business_card_candidate:Boolean(body.querySelector(".card_container.businesscardmsg")),
        send_status:"unknown",server_ack_verified:false,
      });
    }
    // Assign only after all visible matching nodes pass; never return a partial foreign/cached scope.
    result.messages=messages;
    result.state="ready";result.scope_ready=true;
    result.account_scope_verified=true;result.conversation_scope_verified=true;
    return result;
  },{accountId:accountId.toLowerCase(),accountDisplayName:accountDisplayName.trim(),profileProof:recentProfileProof});
  if(result.scope_ready === true && result.profile_binding_source === "current_native_profile") {
    // Keep immutable identity/time values tied to this result and this page object.
    // A fallback result cannot renew the original proof's ten-second lifetime.
    nativeProfileProofs.set(result,{page,proof:{
      account_id:result.account_id,account_display_name:result.account_display_name,
      conversation_id:result.conversation_id,profile_uid:result.conversation_ui.profile_uid,
      row_nickname:result.conversation_ui.row_nickname,header_nickname:result.conversation_ui.header_nickname,
      title:result.title,url:result.url,observed_at_utc:result.profile_proof_observed_at_utc,
      message_prefixes:Array.from(new Set(["id_"+result.account_id+"."+result.conversation_id+".",
        "id_"+result.conversation_id+"."+result.account_id+"."])),
    }});
  }
  return result;
}

module.exports={readScope};
