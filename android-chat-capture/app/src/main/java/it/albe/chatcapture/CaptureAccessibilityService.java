package it.albe.chatcapture;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

public class CaptureAccessibilityService extends AccessibilityService {
    private static final String CHATGPT_PACKAGE="com.openai.chatgpt";
    private static final long STABLE_MS=2800;

    private final Handler handler=new Handler(Looper.getMainLooper());
    private String lastEditable="";
    private String lastTyped="";
    private String pendingUser="";
    private String lastUser="";
    private String assistantCandidate="";
    private String lastWindowDigest="";
    private long lastSnapshotPingAt=0;
    private long candidateChangedAt=0;
    private boolean awaitingAssistant=false;
    private String conversationId="";
    private String conversationTitle="ChatGPT";
    private final Runnable finalizeAssistant=this::maybeFinalizeAssistant;

    private static final Set<String> UI_BLACKLIST = new HashSet<>(Arrays.asList(
        "copy","copia","like","dislike","share","condividi","regenerate","rigenera",
        "read aloud","leggi ad alta voce","edit","modifica","stop","interrompi",
        "send","invia","new chat","nuova chat","voice","voce","attach","allega",
        "menu","altre azioni","more actions","prosegui","continue","sto pensando","thinking",
        "rispondi a chatgpt","reply to chatgpt","dettatura","dictation",
        "allegato","attachment","in elaborazione…","in elaborazione...","processing…","processing..."
    ));

    @Override public void onServiceConnected() {
        super.onServiceConnected();
        SharedPreferences p=getSharedPreferences("capture",MODE_PRIVATE);
        conversationId=p.getString("current_conversation_id","");
        conversationTitle=p.getString("current_conversation_title","ChatGPT");
        if(conversationId.isEmpty()) newConversation("ChatGPT");
        ApiClient.flush(this);
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if(event==null || event.getPackageName()==null) return;
        if(!CHATGPT_PACKAGE.contentEquals(event.getPackageName())) return;

        int type=event.getEventType();

        if(type==AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
            AccessibilityNodeInfo s=event.getSource();
            if(s!=null && s.isEditable()) {
                String t=nodeText(s).trim();
                if(!t.isEmpty()) {
                    lastTyped=t;
                    lastEditable=t;
                }
            }
        }

        if(type==AccessibilityEvent.TYPE_VIEW_CLICKED) {
            AccessibilityNodeInfo s=event.getSource();
            String clicked=nodeText(s).trim();
            String low=clicked.toLowerCase(Locale.ROOT);
            String id=s!=null && s.getViewIdResourceName()!=null?s.getViewIdResourceName().toLowerCase(Locale.ROOT):"";
            String desc=s!=null && s.getContentDescription()!=null?s.getContentDescription().toString().toLowerCase(Locale.ROOT):"";
            String context=clickContext(s).toLowerCase(Locale.ROOT);

            if(isNewChatControl(low,desc,id,context)) {
                newConversation("ChatGPT");
            } else if(
                low.equals("send") || low.equals("invia") ||
                desc.contains("send") || desc.contains("invia") ||
                id.contains("send")
            ) {
                if(!lastTyped.trim().isEmpty()) {
                    pendingUser=lastTyped.trim();
                    sendUser(pendingUser);
                    pendingUser="";
                    lastTyped="";
                }
            } else if((id.contains("conversation")||id.contains("history")) && isPossibleTitle(clicked)) {
                switchConversationByTitle(clicked);
            }
        }

        scan();
    }

    private void scan() {
        AccessibilityNodeInfo root=getRootInActiveWindow();
        if(root==null) return;
        ArrayList<NodeText> nodes=new ArrayList<>();
        collect(root,nodes);

        String editable="";
        for(NodeText n:nodes) if(n.editable && n.text.length()>=editable.length()) editable=n.text;

        if(!editable.isEmpty()) {
            lastEditable=editable;
            lastTyped=editable;
        }

        // Fallback robusto: nell'app ChatGPT il tap su "Invia" non sempre
        // genera un evento clic leggibile. Quando il testo digitato ricompare
        // nella conversazione come nodo non-editabile, consideriamo il turno inviato.
        if(!lastTyped.isEmpty()) {
            boolean typedVisibleAsMessage=false;
            String nt=normalize(lastTyped);
            for(NodeText n:nodes) {
                if(!n.editable && normalize(n.text).equals(nt)) {
                    typedVisibleAsMessage=true;
                    break;
                }
            }
            boolean stillInComposer=!editable.isEmpty() && normalize(editable).equals(nt);
            if(typedVisibleAsMessage && !stillInComposer && !normalize(lastUser).equals(nt)) {
                String sent=lastTyped.trim();
                lastTyped="";
                lastEditable="";
                sendUser(sent);
            }
        }

        if(!pendingUser.isEmpty()) {
            boolean seen=false;
            for(NodeText n:nodes) if(!n.editable && normalize(n.text).equals(normalize(pendingUser))) {seen=true;break;}
            if(seen) {
                sendUser(pendingUser);
                pendingUser="";
            }
        }

        if(awaitingAssistant && !lastUser.isEmpty()) {
            try {
                String snapshot=windowSnapshot(root);
                String digest=hash(snapshot);
                if(!digest.equals(lastWindowDigest)) {
                    JSONObject s=new JSONObject();
                    s.put("conversationId",conversationId);
                    s.put("title",conversationTitle);
                    s.put("userText",lastUser);
                    s.put("snapshot",snapshot);
                    ApiClient.sendSnapshot(this,s);
                    lastWindowDigest=digest;
                }
            } catch(Exception ignored){}
        }
        ApiClient.flush(this);
    }

    private void sendUser(String text) {
        text=text.trim();
        if(text.isEmpty()) return;
        lastUser=text;
        lastTyped="";
        lastWindowDigest="";
        awaitingAssistant=true;
        assistantCandidate="";
        candidateChangedAt=System.currentTimeMillis();
        handler.removeCallbacks(finalizeAssistant);
        postTurn("user",text,hash(conversationId+"|user|"+System.currentTimeMillis()+"|"+text));
    }

    private void maybeFinalizeAssistant() {
        if(!awaitingAssistant || assistantCandidate.trim().isEmpty()) return;
        long elapsed=System.currentTimeMillis()-candidateChangedAt;
        if(elapsed<STABLE_MS) {
            handler.postDelayed(finalizeAssistant, STABLE_MS-elapsed);
            return;
        }
        String text=assistantCandidate.trim();
        postTurn("assistant",text,hash(conversationId+"|assistant|"+text));
        awaitingAssistant=false;
        assistantCandidate="";
        lastUser="";
    }

    private void postTurn(String role,String text,String messageId) {
        try {
            JSONObject j=new JSONObject();
            j.put("conversationId",conversationId);
            j.put("messageId",messageId);
            j.put("title",conversationTitle);
            j.put("role",role);
            j.put("text",text);
            ApiClient.enqueue(this,j);
        } catch(Exception ignored){}
    }

    private String extractAfterUser(List<NodeText> nodes,String user) {
        int idx=-1;
        String nu=normalize(user);
        for(int i=0;i<nodes.size();i++) {
            NodeText n=nodes.get(i);
            if(!n.editable && normalize(n.text).equals(nu)) idx=i;
        }
        if(idx<0) return assistantCandidate;

        LinkedHashSet<String> parts=new LinkedHashSet<>();
        for(int i=idx+1;i<nodes.size();i++) {
            NodeText n=nodes.get(i);
            String t=n.text.trim();
            if(n.editable || t.isEmpty() || isUiText(t) || normalize(t).equals(nu)) continue;
            if(isTransientUiText(t)) continue;
            if(t.length()==1 && !Character.isLetterOrDigit(t.charAt(0))) continue;
            parts.add(t);
        }
        StringBuilder sb=new StringBuilder();
        for(String p:parts) {
            if(sb.length()>0) sb.append("\n\n");
            sb.append(p);
        }
        String s=sb.toString().trim();
        if(s.length()>3) return s;
        return assistantCandidate;
    }

    private void collect(AccessibilityNodeInfo n,List<NodeText> out) {
        if(n==null || !n.isVisibleToUser()) return;
        String t=nodeText(n).trim();
        if(!t.isEmpty()) {
            Rect r=new Rect(); n.getBoundsInScreen(r);
            out.add(new NodeText(t,n.isEditable(),r.top,r.bottom));
        }
        for(int i=0;i<n.getChildCount();i++) collect(n.getChild(i),out);
    }

    private boolean isNewChatControl(String low,String desc,String id,String context) {
        String all=(low+" "+desc+" "+id+" "+context).toLowerCase(Locale.ROOT);
        return all.contains("new chat") ||
               all.contains("nuova chat") ||
               all.contains("start new chat") ||
               all.contains("inizia nuova chat") ||
               all.contains("create chat") ||
               all.contains("compose") ||
               id.contains("new_chat") ||
               id.contains("newchat") ||
               id.contains("compose");
    }

    private String clickContext(AccessibilityNodeInfo n) {
        if(n==null) return "";
        StringBuilder sb=new StringBuilder();
        AccessibilityNodeInfo cur=n;
        for(int depth=0; depth<4 && cur!=null; depth++) {
            appendNodeContext(cur,sb);
            for(int i=0;i<cur.getChildCount();i++) {
                AccessibilityNodeInfo c=cur.getChild(i);
                appendNodeContext(c,sb);
            }
            AccessibilityNodeInfo p=cur.getParent();
            if(cur!=n) try { cur.recycle(); } catch(Exception ignored){}
            cur=p;
        }
        if(cur!=null) try { cur.recycle(); } catch(Exception ignored){}
        return sb.toString();
    }

    private void appendNodeContext(AccessibilityNodeInfo n,StringBuilder sb) {
        if(n==null) return;
        CharSequence t=n.getText();
        CharSequence d=n.getContentDescription();
        String id=n.getViewIdResourceName();
        if(t!=null) sb.append(' ').append(t);
        if(d!=null) sb.append(' ').append(d);
        if(id!=null) sb.append(' ').append(id);
    }

    private String nodeText(AccessibilityNodeInfo n) {
        if(n==null) return "";
        CharSequence t=n.getText();
        if(t!=null && t.length()>0) return t.toString();
        CharSequence d=n.getContentDescription();
        return d==null?"":d.toString();
    }

    private String windowSnapshot(AccessibilityNodeInfo root) {
        ArrayList<NodeText> nodes=new ArrayList<>();
        collect(root,nodes);
        StringBuilder sb=new StringBuilder();
        int i=0;
        for(NodeText n:nodes) {
            String t=n.text==null?"":n.text.trim();
            if(t.isEmpty()) continue;
            if(sb.length()>0) sb.append("\n");
            sb.append(i++).append("|").append(n.editable?"E":"T").append("|").append(t.replace("\n"," ↵ "));
            if(sb.length()>5000) break;
        }
        return sb.toString();
    }

    private boolean isSubstantiveAssistant(String s) {
        if(s==null) return false;
        String cleaned=s.trim();
        if(cleaned.length()<12) return false;
        String[] lines=cleaned.split("\\n+");
        int meaningful=0;
        for(String line:lines) {
            String t=line.trim();
            if(t.isEmpty() || isUiText(t) || isTransientUiText(t)) continue;
            if(t.length()>=8) meaningful++;
        }
        return meaningful>0;
    }

    private boolean isTransientUiText(String s) {
        String l=s==null?"":s.trim().toLowerCase(Locale.ROOT);
        if(l.isEmpty()) return true;
        if(l.startsWith("sto pensando") || l.startsWith("thinking")) return true;
        if(l.startsWith("elaborato per ") || l.startsWith("thought for ")) return true;
        if(l.startsWith("in elaborazione") || l.startsWith("processing")) return true;
        if(l.equals("prosegui") || l.equals("continue")) return true;
        if(l.equals("rispondi a chatgpt") || l.equals("reply to chatgpt")) return true;
        if(l.equals("dettatura") || l.equals("dictation")) return true;
        if(l.equals("allegato") || l.equals("attachment")) return true;
        return false;
    }

    private boolean isUiText(String s) {
        String l=s.trim().toLowerCase(Locale.ROOT);
        if(UI_BLACKLIST.contains(l)) return true;
        if(l.startsWith("chatgpt can make mistakes") || l.startsWith("chatgpt può commettere errori")) return true;
        if(l.startsWith("allega") || l.startsWith("attach")) return true;
        if(l.startsWith("rispondi a chatgpt") || l.startsWith("reply to chatgpt")) return true;
        if(l.startsWith("dettatura") || l.startsWith("dictation")) return true;
        if(l.startsWith("microfono") || l.startsWith("microphone")) return true;
        if(l.startsWith("modalità voce") || l.startsWith("voice mode")) return true;
        if(l.matches("^(copy|copia|share|condividi|like|dislike|edit|modifica|menu|altre azioni|more actions).*$")) return true;
        return false;
    }

    private boolean isPossibleTitle(String s) {
        String x=s==null?"":s.trim();
        if(x.length()<3 || x.length()>100 || isUiText(x)) return false;
        String l=x.toLowerCase(Locale.ROOT);
        return !l.equals("chatgpt") && !l.startsWith("gpt-");
    }

    private void switchConversationByTitle(String title) {
        SharedPreferences p=getSharedPreferences("capture",MODE_PRIVATE);
        String key="title_"+hash(title).substring(0,16);
        String id=p.getString(key,"");
        if(id.isEmpty()) id=UUID.randomUUID().toString();
        conversationId=id;
        conversationTitle=title;
        p.edit().putString(key,id).putString("current_conversation_id",id).putString("current_conversation_title",title).apply();
        resetTurnState();
    }

    private void newConversation(String title) {
        conversationId=UUID.randomUUID().toString();
        conversationTitle=title;
        getSharedPreferences("capture",MODE_PRIVATE).edit()
            .putString("current_conversation_id",conversationId)
            .putString("current_conversation_title",conversationTitle).apply();
        resetTurnState();
    }

    private void resetTurnState() {
        lastEditable=""; lastTyped=""; pendingUser=""; lastUser=""; assistantCandidate=""; awaitingAssistant=false;
        handler.removeCallbacks(finalizeAssistant);
    }

    private String normalize(String s){return s==null?"":s.trim().replaceAll("\\s+"," ");}

    private String hash(String s) {
        try {
            byte[] b=MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb=new StringBuilder();
            for(byte x:b) sb.append(String.format(Locale.ROOT,"%02x",x));
            return sb.toString();
        } catch(Exception e) { return UUID.randomUUID().toString().replace("-",""); }
    }

    @Override public void onInterrupt(){}

    static class NodeText {
        final String text; final boolean editable; final int top,bottom;
        NodeText(String t,boolean e,int a,int b){text=t;editable=e;top=a;bottom=b;}
    }
}
