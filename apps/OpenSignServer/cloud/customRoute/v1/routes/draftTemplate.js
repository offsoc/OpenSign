import axios from 'axios';
import {
  color,
  customAPIurl,
  saveFileUsage,
  formatWidgetOptions,
  sanitizeFileName,
} from '../../../../Utils.js';
import uploadFileToS3 from '../../../parsefunction/uploadFiletoS3.js';
import jwt from 'jsonwebtoken';

const randomId = () => Math.floor(1000 + Math.random() * 9000);
export default async function draftTemplate(request, response) {
  const name = request.body.title;
  const note = request.body.note;
  const description = request.body.description;
  const signers = request.body.signers;
  const folderId = request.body.folderId;
  const base64File = request.body.file;
  const fileData = request.files?.[0] ? request.files[0].buffer : null;
  const SendinOrder = request.body.sendInOrder || true;
  const isEnableOTP = request.body?.enableOTP === true ? true : false;
  const isTourEnabled = request.body?.enableTour || false;
  const isPublic = request.body?.isPublic;
  const protocol = customAPIurl();
  const baseUrl = new URL(process.env.PUBLIC_URL).origin;

  try {
    const reqToken = request.headers['x-api-token'];
    if (!reqToken) {
      return response.status(400).json({ error: 'Please Provide API Token' });
    }
    const tokenQuery = new Parse.Query('appToken');
    tokenQuery.equalTo('token', reqToken);
    tokenQuery.include('userId');
    const token = await tokenQuery.first({ useMasterKey: true });
    if (token !== undefined) {
      // Valid Token then proceed request
      const parseUser = JSON.parse(JSON.stringify(token));
      const userPtr = {
        __type: 'Pointer',
        className: '_User',
        objectId: parseUser.userId.objectId,
      };
      const contractsUser = new Parse.Query('contracts_Users');
      contractsUser.equalTo('UserId', userPtr);
      contractsUser.include('TenantId');
      const extUser = await contractsUser.first({ useMasterKey: true });
      const parseExtUser = JSON.parse(JSON.stringify(extUser));
      let fileUrl;
      if (request.files?.[0]) {
        const base64 = fileData?.toString('base64');
        const file = new Parse.File(request.files?.[0]?.originalname, {
          base64: base64,
        });
        await file.save({ useMasterKey: true });
        fileUrl = file.url();
        const buffer = Buffer.from(base64, 'base64');
        saveFileUsage(buffer.length, fileUrl, parseUser.userId.objectId);
      } else {
        const filename = sanitizeFileName(`${name}.pdf`);
        let adapter = {};
        const ActiveFileAdapter = parseExtUser?.TenantId?.ActiveFileAdapter || '';
        if (ActiveFileAdapter) {
          adapter =
            parseExtUser?.TenantId?.FileAdapters?.find(x => (x.id = ActiveFileAdapter)) || {};
        }
        if (adapter?.id) {
          const filedata = Buffer.from(base64File, 'base64');
          // `uploadFileToS3` is used to save document in user's file storage
          fileUrl = await uploadFileToS3(filedata, filename, 'application/pdf', adapter);
        } else {
          const file = new Parse.File(filename, { base64: base64File }, 'application/pdf');
          await file.save({ useMasterKey: true });
          fileUrl = file.url();
        }
        const buffer = Buffer.from(base64File, 'base64');
        saveFileUsage(buffer.length, fileUrl, parseUser.userId.objectId);
      }
      const extUserPtr = {
        __type: 'Pointer',
        className: 'contracts_Users',
        objectId: extUser.id,
      };
      const object = new Parse.Object('contracts_Template');
      object.set('Name', name);
      if (note) {
        object.set('Note', note);
      }
      if (description) {
        object.set('Description', description);
      }
      if (SendinOrder) {
        object.set('SendinOrder', SendinOrder);
      }
      object.set('URL', fileUrl);
      object.set('CreatedBy', userPtr);
      object.set('ExtUserPtr', extUserPtr);
      object.set('IsEnableOTP', isEnableOTP);
      object.set('IsTourEnabled', isTourEnabled);
      const Public = isPublic !== undefined ? isPublic : false;
      if (isPublic !== undefined) {
        object.set('IsPublic', Public);
      }
      let contact = [];
      if (signers && signers.length > 0) {
        let parseSigners;
        if (base64File) {
          parseSigners = signers;
        } else {
          parseSigners = JSON.parse(signers);
        }
        let createContactUrl = protocol + '/v1/createcontact';

        for (const [index, element] of parseSigners.entries()) {
          if (element?.name && element?.email) {
            const body = {
              name: element?.name,
              email: element?.email,
              phone: element?.phone || '',
            };
            try {
              const res = await axios.post(createContactUrl, body, {
                headers: { 'Content-Type': 'application/json', 'x-api-token': reqToken },
              });
              // console.log('res ', res.data);
              const contactPtr = {
                __type: 'Pointer',
                className: 'contracts_Contactbook',
                objectId: res.data?.objectId,
              };
              const newObj = { ...element, contactPtr: contactPtr, index: index };
              contact.push(newObj);
            } catch (err) {
              // console.log('err ', err.response);
              if (err?.response?.data?.objectId) {
                const contactPtr = {
                  __type: 'Pointer',
                  className: 'contracts_Contactbook',
                  objectId: err.response.data?.objectId,
                };
                const newObj = { ...element, contactPtr: contactPtr, index: index };
                contact.push(newObj);
              }
            }
          } else {
            const newObj = { ...element, contactPtr: {}, index: index };
            contact.push(newObj);
          }
        }
        const updatedSigners = contact?.filter(x => x.contactPtr && x.contactPtr.objectId);
        if (updatedSigners && updatedSigners.length > 0) {
          object.set(
            'Signers',
            updatedSigners?.map(x => x.contactPtr)
          );
        }
        let updatePlaceholders = [];
        for (const signer of contact) {
          const placeHolder = [];
          if (signer.widgets?.length > 0) {
            for (const widget of signer.widgets) {
              const pageNumber = widget.page;
              const page = placeHolder.find(page => page.pageNumber === pageNumber);
              const options = formatWidgetOptions(widget.type, widget.options);
              const widgetData = {
                isStamp: widget.type === 'stamp' || widget.type === 'image',
                key: randomId(),
                isDrag: false,
                scale: 1,
                isMobile: false,
                zIndex: 1,
                type: widget.type === 'textbox' ? 'text input' : widget.type,
                options: options,
                Width: widget.w,
                Height: widget.h,
                xPosition: widget.x,
                yPosition: widget.y,
              };

              if (page) {
                page.pos.push(widgetData);
              } else {
                placeHolder.push({ pageNumber, pos: [widgetData] });
              }
            }
          }
          updatePlaceholders.push({
            signerObjId: signer?.contactPtr?.objectId || '',
            signerPtr: signer?.contactPtr,
            Role: signer.role,
            Id: randomId(),
            blockColor: color[signer?.index],
            placeHolder,
          });
        }
        if (updatePlaceholders?.length > 0) {
          object.set('Placeholders', updatePlaceholders);
        }
      }
      if (folderId) {
        object.set('Folder', {
          __type: 'Pointer',
          className: 'contracts_Template',
          objectId: folderId,
        });
      }
      if (parseExtUser?.TenantId?.ActiveFileAdapter) {
        object.set('FileAdapterId', parseExtUser?.TenantId?.ActiveFileAdapter);
      }
      const newACL = new Parse.ACL();
      newACL.setPublicReadAccess(false);
      newACL.setPublicWriteAccess(false);
      newACL.setReadAccess(userPtr.objectId, true);
      newACL.setWriteAccess(userPtr.objectId, true);
      object.setACL(newACL);
      const res = await object.save(null, { useMasterKey: true });
      if (request.posthog) {
        request.posthog?.capture({
          distinctId: parseUser.userId.email,
          event: 'api_draft_template',
          properties: { response_code: 200 },
        });
      }
      const JwtToken = jwt.sign(
        { user_email: parseUser.userId.email, template_id: res.id },
        reqToken
      );

      return response.json({ objectId: res.id, url: `${baseUrl}/drafttemplate/${JwtToken}` });
    } else {
      return response.status(405).json({ error: 'Invalid API Token!' });
    }
  } catch (err) {
    console.log('err ', err);
    return response.status(400).json({ error: 'Something went wrong, please try again later!' });
  }
}
